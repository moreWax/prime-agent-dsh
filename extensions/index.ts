import { compact as compactPrime, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig } from "../src/config.js";
import { notificationSummary } from "../src/notifications.js";
import { RuntimeManager } from "../src/runtime-manager.js";
import { PrimeRouteRegistry, type PreparedPrimeRoute } from "../src/model-route.js";
import { registerShadowContextTelemetry } from "./shadow-context.js";
import { DurableCompactionController, loadCompactionPlannerConfig } from "../src/compaction.js";
import { loadConfig as loadProviderConfig } from "../src/dsh-provider-config.js";
import { bindSessionRuntime, createInstanceRuntime, registerProvider } from "../src/dsh-provider.js";
import { TransparentProviderController } from "../src/transparent-provider.js";
import { createPrimeUserQuestionAnswerer, rejectHeadlessUserQuestion } from "../src/prime-user-questions.js";
import { dshCapabilityRegistry, formatDshCapabilities } from "../src/dsh-capabilities.js";

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

/** Number of committed message entries in the current session (0 = fresh). */
function committedMessages(ctx: ExtensionContext): number {
  try {
    return ctx.sessionManager.getBranch().filter((entry) => (entry as { type?: string }).type === "message").length;
  } catch {
    return 0;
  }
}

/** Most recent sibling session file (same dir, older than this one), if fresh. */
function recentSiblingSession(ctx: ExtensionContext): { id: string; ageMinutes: number } | undefined {
  try {
    const dir = ctx.sessionManager.getSessionDir();
    const current = ctx.sessionManager.getSessionFile();
    if (!dir || !current) return undefined;
    const now = Date.now();
    let best: { id: string; mtime: number } | undefined;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const full = join(dir, name);
      if (full === current) continue;
      let mtime: number;
      try { mtime = statSync(full).mtimeMs; } catch { continue; }
      if (!best || mtime > best.mtime) best = { id: basename(name, ".jsonl"), mtime };
    }
    if (!best || best.mtime >= now) return undefined;
    const ageMinutes = Math.round((now - best.mtime) / 60000);
    if (ageMinutes > 720) return undefined; // only nudge for recent siblings
    return { id: best.id, ageMinutes };
  } catch {
    return undefined;
  }
}


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
  const transparentController = new TransparentProviderController(pi, providerConfig, {
    dshHome: (ctx) => loadConfig(ctx.cwd, {
      dshBin: pi.getFlag("dsh-bin") as string | undefined,
      dshHome: pi.getFlag("dsh-home") as string | undefined,
    }).dshHome,
  });
  transparentController.register();
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
      const messages = committedMessages(ctx);
      const modelLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
      const dshState = transparentController.isEnabled ? "on" : "off";
      if (messages > 0) {
        ctx.ui.notify(`Session resumed (${messages} messages) · DSH ${dshState} · model ${modelLabel}`, "info");
      } else {
        const sibling = recentSiblingSession(ctx);
        const hint = sibling
          ? ` · a session from ${sibling.ageMinutes} min ago exists — resume it to keep context`
          : "";
        ctx.ui.notify(`Fresh session · DSH ${dshState} · model ${modelLabel}${hint}`, "info");
      }
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
    description: "Delegate a task to the real DeepSeek Harness runtime. DSH owns the delegated session, context, tools, compaction, skills, subagents, and installed memory plugins; inference uses Prime's currently selected model. Reuse sessionId for follow-ups. Optional images are sent as ACP image blocks.",
    promptGuidelines: [
      "Use deepseek_harness only when the user asks to use or delegate to DeepSeek Harness (DSH).",
      "For a follow-up, pass the sessionId returned by the preceding deepseek_harness call.",
      "When delegation needs vision, pass canonical base64 images in the images array.",
      "Do not claim Prime's current transcript was copied into DSH; provide all task-critical context in prompt.",
      "DeepSeek Harness is the context/agent harness here, not the model provider; inference follows Prime's active model.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Self-contained task or follow-up for DeepSeek Harness" }),
      images: Type.Optional(Type.Array(Type.Object({
        data: Type.String({ description: "Canonical base64-encoded image bytes" }),
        mimeType: Type.Union([
          Type.Literal("image/png"), Type.Literal("image/jpeg"),
          Type.Literal("image/webp"), Type.Literal("image/gif"),
        ]),
      }), { maxItems: 20, description: "Images to append after the prompt, admitted by DSH's ACP attachment gateway" })),
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
        const promptBlocks = params.images?.length
          ? [{ type: "text" as const, text: params.prompt }, ...params.images.map((image) => ({
              type: "image" as const, data: image.data, mimeType: image.mimeType,
            }))]
          : undefined;
        const result = await manager.run(params.prompt, config, {
          cwd: ctx.cwd,
          promptBlocks,
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

    // Single user-facing command (devX: three words max). Control verbs act on
  // the session; "run" delegates a one-shot task; the rest are diagnostics
  // reachable on demand instead of cluttering the palette.
  pi.registerCommand("dsh-session", {
    description: "DSH for this session: on | off | status | capabilities | doctor | run <task>",
    handler: async (args, ctx) => {
      await Promise.resolve();
      const [rawVerb, ...rest] = args.trim().split(/\s+/);
      const verb = (rawVerb ?? "").toLowerCase();
      const commandCtx = ctx as unknown as Parameters<typeof transparentController.setEnabled>[1];
      const runTask = async (task: string): Promise<void> => {
        if (!task) { ctx.ui.notify("Usage: /dsh-session run <task>", "warning"); return; }
        const config = await configFor(pi, ctx);
        const sessionId = sessionFor(ctx);
        ctx.ui.setStatus("deepseek-harness", "DSH running");
        try {
          const result = await manager.run(task, config, {
            cwd: ctx.cwd,
            sessionId,
            onPermission: async (title, choices) => {
              if (!ctx.hasUI) return undefined;
              const labels = choices.map((choice) => `${choice.allow ? "Allow" : "Reject"}: ${choice.label}`);
              const selected = await ctx.ui.select(title, labels);
              const index = selected === undefined ? -1 : labels.indexOf(selected);
              return index >= 0 ? choices[index]?.id : undefined;
            },
          });
          pi.sendMessage({ customType: "deepseek-harness", content: result.text || "DeepSeek Harness completed without text.", display: true,
            details: { sessionId: result.sessionId, state: "completed", profile: config.profile, provider: config.provider, model: config.model } satisfies DshDetails },
            { deliverAs: "nextTurn" });
          ctx.ui.notify(`DeepSeek Harness completed (${result.sessionId})`, "info");
        } catch (error) {
          ctx.ui.notify(`DeepSeek Harness failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        } finally { ctx.ui.setStatus("deepseek-harness", undefined); }
      };
      if (verb === "on") {
        transparentController.setEnabled(true, commandCtx);
        ctx.ui.notify("DSH is enabled for this session.", "info");
        return;
      }
      if (verb === "off") {
        transparentController.setEnabled(false, commandCtx);
        ctx.ui.notify("DSH is disabled for this session.", "info");
        return;
      }
      if (verb === "status") {
        const config = loadConfig(ctx.cwd, { dshBin: pi.getFlag("dsh-bin") as string | undefined,
          dshHome: pi.getFlag("dsh-home") as string | undefined });
        const status = manager.status();
        const selected = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
        const transparent = transparentController.isEnabled ? "on" : "off";
        ctx.ui.notify(`DSH: transparent=${transparent}, Prime model=${selected}, runtimes=${status.length}, home=${config.dshHome}`, "info");
        return;
      }
      if (verb === "capabilities") {
        const capabilitiesConfig = loadProviderConfig();
        ctx.ui.notify(formatDshCapabilities(dshCapabilityRegistry(capabilitiesConfig)), "info");
        return;
      }
      if (verb === "doctor") {
        const config = await configFor(pi, ctx);
        ctx.ui.notify(`Checking DSH ${config.profile} runtime...`, "info");
        try {
          const result = await manager.doctor(config, ctx.cwd);
          ctx.ui.notify(`DSH ACP bridge OK (protocol ${result.protocolVersion})`, "info");
        } catch (error) {
          ctx.ui.notify(`DSH doctor failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      if (verb === "run") { await runTask(rest.join(" ").trim()); return; }
      ctx.ui.notify("Usage: /dsh-session on | off | status | capabilities | doctor | run <task>", "warning");
    },
  });
}
