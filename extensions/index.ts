import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { notificationSummary } from "../src/notifications.js";
import { RuntimeManager } from "../src/runtime-manager.js";
import { PrimeRouteRegistry } from "../src/model-route.js";

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


interface DshModeState { enabled: boolean; }
const MODE_ENTRY = "deepseek-harness-mode";
const MESSAGE_TYPE = "deepseek-harness";
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
    let details: Partial<DshDetails> | undefined;
    if (entry?.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "deepseek_harness") {
      details = entry.message.details as Partial<DshDetails> | undefined;
    } else if (entry?.type === "custom_message" && entry.customType === MESSAGE_TYPE) {
      details = entry.details as Partial<DshDetails> | undefined;
    }
    if (details?.state === "completed" && typeof details.sessionId === "string" && details.sessionId !== "new-session") return details.sessionId;
  }
  return undefined;
}

export default function deepSeekHarnessExtension(pi: ExtensionAPI) {
  let manager = new RuntimeManager();
  let dshMode = false;

  const restoreMode = (ctx: ExtensionContext): void => {
    dshMode = ctx.hasUI;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === MODE_ENTRY) dshMode = Boolean((entry.data as DshModeState | undefined)?.enabled);
    }
  };
  pi.on("session_start", async (_event, ctx) => restoreMode(ctx));
  pi.on("session_tree", async (_event, ctx) => restoreMode(ctx));

  pi.registerFlag("dsh-bin", { type: "string", description: "Path to a compatible dsh executable" });
  pi.registerFlag("dsh-home", { type: "string", description: "Isolated DSH_HOME used by the bridge" });

  pi.on("session_shutdown", async () => {
    await manager.closeAll();
    await routes.closeAll();
    manager = new RuntimeManager();
  });

  pi.on("context", async (event) => ({
    // DSH-mode transcript mirrors are presentation/provenance only. If the
    // user switches back to Prime-native mode, never feed those custom-role
    // echoes into Prime as a second, incorrectly-role-tagged conversation.
    messages: event.messages.filter((message) => message.role !== "custom" || message.customType !== MESSAGE_TYPE),
  }));

  pi.on("input", async (event, ctx) => {
    if (!dshMode || event.source === "extension") return { action: "continue" };
    const content = [
      { type: "text" as const, text: event.text },
      ...(event.images ?? []),
    ];
    pi.sendMessage({ customType: MESSAGE_TYPE, content, display: true,
      details: { direction: "user", state: "running" } });
    ctx.ui.setStatus("deepseek-harness", "DSH running");
    try {
      const config = await configFor(pi, ctx);
      const previousSession = sessionFor(ctx);
      const blocks = [
        { type: "text" as const, text: event.text },
        ...(event.images ?? []).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
      ];
      const result = await manager.run(event.text, config, {
        cwd: ctx.cwd,
        sessionId: previousSession,
        promptBlocks: blocks,
        signal: ctx.signal,
        onPermission: async (title, choices) => {
          if (!ctx.hasUI) return undefined;
          const labels = choices.map((choice) => `${choice.allow ? "Allow" : "Reject"}: ${choice.label}`);
          const selected = await ctx.ui.select(title, labels);
          const index = selected === undefined ? -1 : labels.indexOf(selected);
          return index >= 0 ? choices[index]?.id : undefined;
        },
        onUpdate(notification) {
          const summary = notificationSummary(notification);
          if (summary) ctx.ui.setStatus("deepseek-harness", summary.replace("DeepSeek Harness: ", "DSH "));
        },
      });
      const completed = result.stopReason === "end_turn";
      const details: DshDetails = { sessionId: result.sessionId, state: completed ? "completed" : "failed",
        profile: config.profile, provider: config.provider, model: config.model, updates: result.updates.length,
        stopReason: result.stopReason, resumed: result.resumed };
      pi.sendMessage({ customType: MESSAGE_TYPE, content: result.text || `DeepSeek Harness stopped: ${result.stopReason}`,
        display: true, details });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pi.sendMessage({ customType: MESSAGE_TYPE, content: `DeepSeek Harness failed: ${message}`, display: true,
        details: { sessionId: "none", state: "failed", profile: "acp", provider: ctx.model?.provider ?? "none",
          model: ctx.model?.id ?? "none", error: message } satisfies DshDetails });
    } finally {
      ctx.ui.setStatus("deepseek-harness", undefined);
    }
    return { action: "handled" };
  });

  pi.registerCommand("dsh-on", {
    description: "Route every ordinary message in this Prime session through DeepSeek Harness",
    handler: async (_args, ctx) => {
      dshMode = true;
      pi.appendEntry(MODE_ENTRY, { enabled: true } satisfies DshModeState);
      ctx.ui.notify("DeepSeek Harness mode enabled: DSH now owns context for ordinary messages", "info");
    },
  });

  pi.registerCommand("dsh-off", {
    description: "Return ordinary messages to Prime Agent's native conversation loop",
    handler: async (_args, ctx) => {
      dshMode = false;
      pi.appendEntry(MODE_ENTRY, { enabled: false } satisfies DshModeState);
      ctx.ui.notify("DeepSeek Harness mode disabled", "info");
    },
  });

  pi.registerCommand("dsh-mode", {
    description: "Show whether ordinary messages are routed through DeepSeek Harness",
    handler: async (_args, ctx) => ctx.ui.notify(`DeepSeek Harness mode: ${dshMode ? "on" : "off"}`, "info"),
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
