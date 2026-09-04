import { compact as compactPrime, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { loadConfig } from "../src/config.js";
import { notificationSummary } from "../src/notifications.js";
import { RuntimeManager } from "../src/runtime-manager.js";
import { PrimeRouteRegistry, type PreparedPrimeRoute } from "../src/model-route.js";
import { registerShadowContextTelemetry } from "./shadow-context.js";
import { DurableCompactionController, loadCompactionPlannerConfig } from "../src/compaction.js";
import { CONFIG_PATH_FOR_DIAGNOSTICS, loadConfig as loadProviderConfig } from "../src/dsh-provider-config.js";
import { bindSessionRuntime, createInstanceRuntime, registerProvider } from "../src/dsh-provider.js";
import { TransparentProviderController } from "../src/transparent-provider.js";
import { createPrimeUserQuestionAnswerer, rejectHeadlessUserQuestion } from "../src/prime-user-questions.js";

interface DshDetails {
  sessionId: string;
  state: "running" | "completed" | "failed";
  profile: string;
  provider: string;
  model: string;
  updates?: number;
  stopReason?: string;
  resumed?: boolean;
  error?: string;
}

const routes = new PrimeRouteRegistry();

async function configFor(pi: ExtensionAPI, ctx: ExtensionContext) {
  const config = loadConfig(ctx.cwd, {
    dshBin: pi.getFlag("dsh-bin") as string | undefined,
    dshHome: pi.getFlag("dsh-home") as string | undefined,
  });
  const model = ctx.model as Model<Api> | undefined;
  if (!model) throw new Error("Prime Agent has no active model to route through DeepSeek Harness");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`Could not resolve Prime model authentication: ${auth.error}`);
  const resolvedHeaders = auth.headers
    ? Object.fromEntries(Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : undefined;
  const route = await routes.prepare({ model, auth: { apiKey: auth.apiKey, headers: resolvedHeaders }, thinkingLevel: undefined }, config.dshHome);
  config.profile = "acp";
  config.provider = model.provider;
  config.model = model.id;
  config.patches = [route.patch, ...config.patches];
  config.childEnv = route.env;
  return config;
}

function sessionFor(ctx: ExtensionContext, explicit?: string): string | undefined {
  if (explicit) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(explicit)) throw new Error("sessionId may contain only letters, digits, dot, underscore, and hyphen");
    return explicit;
  }
  // Continue the latest DSH session on this exact Prime branch. If the user
  // forks before that tool result, it is absent from getBranch() and a new
  // branch-scoped DSH session is minted instead.
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "deepseek_harness") continue;
    const details = entry.message.details as Partial<DshDetails> | undefined;
    if (details?.state === "completed" && typeof details.sessionId === "string" && details.sessionId !== "new-session") return details.sessionId;
  }
  return undefined;
}

export default function deepSeekHarnessExtension(pi: ExtensionAPI): void {
  registerShadowContextTelemetry(pi);

  // The selectable `dsh` provider is a real in-process harness. DSH owns its
  // agent loop, context, tools, compaction, skills, subagents, and memories;
  // Prime only supplies the latest user turn and renders DSH's event stream.
  const providerConfig = loadProviderConfig();
  const providerRuntime = createInstanceRuntime();
  let lastNativeModel: Model<Api> | undefined;
  let lastThinkingLevel: ExtensionContext["thinkingLevel"];
  let preparedRoute: PreparedPrimeRoute | undefined;
  const selectNative = (model: Model<Api> | undefined): void => {
    if (model?.provider === "dsh") return;
    if (model) lastNativeModel = model;
    preparedRoute = undefined;
  };
  const resolveProviderRoute = async (ctx: ExtensionContext): Promise<PreparedPrimeRoute> => {
    const model = lastNativeModel;
    if (!model) throw new Error("Select a native Prime model before using the dsh provider");
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(`Could not resolve Prime model authentication: ${auth.error}`);
    const headers = auth.headers
      ? Object.fromEntries(Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : undefined;
    const dshHome = loadConfig(ctx.cwd, { dshBin: pi.getFlag("dsh-bin") as string | undefined,
      dshHome: pi.getFlag("dsh-home") as string | undefined }).dshHome;
    preparedRoute = await routes.prepare({ model, auth: { apiKey: auth.apiKey, headers }, thinkingLevel: lastThinkingLevel }, dshHome);
    return preparedRoute;
  };
  registerProvider(pi, providerConfig, providerRuntime);
  // Keep every native provider id, model entry, and auth flow unchanged. The
  // replacement Provider only intercepts streaming and delegates the complete
  // loop/context/tool lifecycle to the persistent in-process DSH tree.
  new TransparentProviderController(pi, providerConfig, {
    dshHome: (ctx) => loadConfig(ctx.cwd, {
      dshBin: pi.getFlag("dsh-bin") as string | undefined,
      dshHome: pi.getFlag("dsh-home") as string | undefined,
    }).dshHome,
  }).register();
  pi.on("model_select", (event) => {
    selectNative(event.model as Model<Api>);
  });
  pi.on("thinking_level_select", (event) => {
    lastThinkingLevel = event.level;
    preparedRoute = undefined;
  });
  pi.on("session_start", async (_event, ctx) => {
    await Promise.resolve();
    providerRuntime.cwd = ctx.cwd;
    selectNative(ctx.model as Model<Api> | undefined);
    if (!lastNativeModel) {
      // A resumed session can start while `dsh` is selected. Recover the most
      // recent native selection from Prime's branch without copying any auth.
      const branch = ctx.sessionManager.getBranch();
      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index] as { type?: string; provider?: string; modelId?: string } | undefined;
        if (entry?.type !== "model_change" || !entry.provider || !entry.modelId || entry.provider === "dsh") continue;
        const restored = ctx.modelRegistry.find(entry.provider, entry.modelId);
        if (restored) { selectNative(restored); break; }
      }
    }
    lastThinkingLevel = ctx.thinkingLevel;
    providerRuntime.resolveRoute = () => resolveProviderRoute(ctx);
    const sessionId = ctx.sessionManager.getSessionId?.() ?? ctx.cwd;
    providerRuntime.sessionKey = sessionId;
    providerRuntime.approvalAnswerer = ctx.hasUI
      ? ({ toolName, reason }) => ctx.ui.confirm(
          `DSH permission: ${toolName}`,
          reason ?? "Allow this operation once outside the workspace sandbox?",
        )
      : undefined;
    providerRuntime.userQuestionAnswerer = ctx.hasUI
      ? createPrimeUserQuestionAnswerer(ctx.ui)
      : rejectHeadlessUserQuestion;
    bindSessionRuntime(sessionId, providerRuntime);
    if (ctx.hasUI) {
      const configHint = providerConfig.loadedFrom ? "" : `; defaults (no ${CONFIG_PATH_FOR_DIAGNOSTICS})`;
      ctx.ui.notify(
        `DSH provider ready (mode=${providerConfig.mode}, poolMax=${providerConfig.poolMax}${configHint}).`,
        "info",
      );
    }
  });
  let manager = new RuntimeManager();
  pi.registerFlag("dsh-bin", { type: "string", description: "Path to a compatible dsh executable" });
  pi.registerFlag("dsh-home", { type: "string", description: "Isolated DSH_HOME used by the bridge" });
  pi.registerFlag("dsh-compaction", { type: "string", description: "DSH compaction planner: off, shadow, or active" });
  const compactionController = new DurableCompactionController(
    loadCompactionPlannerConfig(pi.getFlag("dsh-compaction") as string | undefined),
    async (event, ctx, plan) => {
      const model = ctx.model as Model<Api> | undefined;
      if (!model) throw new Error("Prime Agent has no active model for compaction");
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(`Could not resolve compaction model authentication: ${auth.error}`);
      const headers = auth.headers
        ? Object.fromEntries(Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : undefined;
      return compactPrime(plan.preparation, model, auth.apiKey, headers, event.customInstructions, event.signal, ctx.thinkingLevel,
        undefined, undefined, undefined, undefined, ctx.sessionManager.getSessionId());
    },
  );
  compactionController.register(pi);

  pi.on("session_shutdown", async () => {
    await manager.closeAll();
    await routes.closeAll();
    manager = new RuntimeManager();
  });

  pi.registerTool({
    name: "deepseek_harness",
    label: "DeepSeek Harness",
    description: "Delegate a task to the real DeepSeek Harness runtime. DSH owns the delegated session, context, tools, compaction, skills, subagents, and installed memory plugins; inference uses Prime's currently selected model. Reuse sessionId for follow-ups.",
    promptGuidelines: [
      "Use deepseek_harness only when the user asks to use or delegate to DeepSeek Harness (DSH).",
      "For a follow-up, pass the sessionId returned by the preceding deepseek_harness call.",
      "Do not claim Prime's current transcript was copied into DSH; provide all task-critical context in prompt.",
      "DeepSeek Harness is the context/agent harness here, not the model provider; inference follows Prime's active model.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Self-contained task or follow-up for DeepSeek Harness" }),
      sessionId: Type.Optional(Type.String({ description: "Existing DSH session ID for continuation; omit for a branch-scoped default" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = await configFor(pi, ctx);
      const sessionId = sessionFor(ctx, params.sessionId);
      const displaySessionId = sessionId ?? "new-session";
      let lastUpdate = "DeepSeek Harness: starting";
      onUpdate?.({
        content: [{ type: "text", text: lastUpdate }],
        details: { sessionId: displaySessionId, state: "running", profile: config.profile, provider: config.provider, model: config.model } satisfies DshDetails,
      });
      try {
        const result = await manager.run(params.prompt, config, {
          cwd: ctx.cwd,
          sessionId,
          signal,
          onPermission: async (title, choices) => {
            if (!ctx.hasUI) return undefined;
            const labels = choices.map((choice) => `${choice.allow ? "Allow" : "Reject"}: ${choice.label}`);
            const selected = await ctx.ui.select(title, labels);
            const index = selected === undefined ? -1 : labels.indexOf(selected);
            return index >= 0 ? choices[index]?.id : undefined;
          },
          onUpdate(notification) {
            const summary = notificationSummary(notification);
            if (!summary || summary === lastUpdate) return;
            lastUpdate = summary;
            onUpdate?.({
              content: [{ type: "text", text: `${summary}\nSession: ${sessionId}` }],
              details: { sessionId: displaySessionId, state: "running", profile: config.profile, provider: config.provider, model: config.model } satisfies DshDetails,
            });
          },
        });
        const completed = result.stopReason === "end_turn";
        const details: DshDetails = { sessionId: result.sessionId, state: completed ? "completed" : "failed", profile: config.profile,
          provider: config.provider, model: config.model, updates: result.updates.length, stopReason: result.stopReason, resumed: result.resumed };
        return { content: [{ type: "text", text: `${result.text || `DeepSeek Harness stopped: ${result.stopReason}`}

DSH session: ${result.sessionId}` }],
          details, ...(completed ? {} : { isError: true }) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `DeepSeek Harness failed: ${message}\nDSH session: ${sessionId}` }],
          details: { sessionId: displaySessionId, state: "failed", profile: config.profile, provider: config.provider, model: config.model, error: message } satisfies DshDetails,
          isError: true };
      }
    },
  });

  pi.registerCommand("dsh", {
    description: "Run a task in the real DeepSeek Harness runtime",
    handler: async (args, ctx) => {
      if (!args.trim()) { ctx.ui.notify("Usage: /dsh <task>", "warning"); return; }
      const config = await configFor(pi, ctx);
      const sessionId = sessionFor(ctx);
      ctx.ui.setStatus("deepseek-harness", "DSH running");
      try {
        const result = await manager.run(args, config, { cwd: ctx.cwd, sessionId });
        pi.sendMessage({ customType: "deepseek-harness", content: result.text || "DeepSeek Harness completed without text.", display: true,
          details: { sessionId: result.sessionId, state: "completed", profile: config.profile, provider: config.provider, model: config.model } satisfies DshDetails },
          { deliverAs: "nextTurn" });
        ctx.ui.notify(`DeepSeek Harness completed (${result.sessionId})`, "info");
      } catch (error) {
        ctx.ui.notify(`DeepSeek Harness failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally { ctx.ui.setStatus("deepseek-harness", undefined); }
    },
  });

  pi.registerCommand("dsh-status", {
    description: "Show bridge runtime status and active configuration",
    handler: async (_args, ctx) => {
      await Promise.resolve();
      const config = loadConfig(ctx.cwd, { dshBin: pi.getFlag("dsh-bin") as string | undefined,
        dshHome: pi.getFlag("dsh-home") as string | undefined });
      const status = manager.status();
      const selected = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
      ctx.ui.notify(`DSH profile=acp, Prime model=${selected}, runtimes=${status.length}, home=${config.dshHome}`, "info");
    },
  });

  pi.registerCommand("dsh-doctor", {
    description: "Verify the DSH ACP initialize/new/close lifecycle without a model call",
    handler: async (_args, ctx) => {
      const config = await configFor(pi, ctx);
      ctx.ui.notify(`Checking DSH ${config.profile} runtime...`, "info");
      try {
        const result = await manager.doctor(config, ctx.cwd);
        ctx.ui.notify(`DSH ACP bridge OK (protocol ${result.protocolVersion})`, "info");
      } catch (error) {
        ctx.ui.notify(`DSH doctor failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
