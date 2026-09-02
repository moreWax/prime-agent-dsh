import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { notificationSummary } from "../src/notifications.js";
import { RuntimeManager } from "../src/runtime-manager.js";

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

const routePatch = fileURLToPath(new URL("../dsh/acp-route.patch.yml", import.meta.url));

function configFor(pi: ExtensionAPI, cwd: string) {
  const config = loadConfig(cwd, {
    dshBin: pi.getFlag("dsh-bin") as string | undefined,
    dshHome: pi.getFlag("dsh-home") as string | undefined,
  });
  config.profile = "acp";
  config.patches = [routePatch, ...config.patches];
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

export default function deepSeekHarnessExtension(pi: ExtensionAPI) {
  let manager = new RuntimeManager();

  pi.registerFlag("dsh-bin", { type: "string", description: "Path to a compatible dsh executable" });
  pi.registerFlag("dsh-home", { type: "string", description: "Isolated DSH_HOME used by the bridge" });

  pi.on("session_shutdown", async () => {
    await manager.closeAll();
    manager = new RuntimeManager();
  });

  pi.registerTool({
    name: "deepseek_harness",
    label: "DeepSeek Harness",
    description: "Delegate a task to the real DeepSeek Harness runtime. DSH owns the delegated session, context, tools, compaction, skills, subagents, and installed memory plugins. Reuse sessionId for follow-ups.",
    promptGuidelines: [
      "Use deepseek_harness only when the user asks to use or delegate to DeepSeek Harness (DSH).",
      "For a follow-up, pass the sessionId returned by the preceding deepseek_harness call.",
      "Do not claim Prime's current transcript was copied into DSH; provide all task-critical context in prompt.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Self-contained task or follow-up for DeepSeek Harness" }),
      sessionId: Type.Optional(Type.String({ description: "Existing DSH session ID for continuation; omit for a branch-scoped default" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = configFor(pi, ctx.cwd);
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
      const config = configFor(pi, ctx.cwd);
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
      const config = configFor(pi, ctx.cwd);
      const status = manager.status();
      ctx.ui.notify(`DSH profile=${config.profile}, provider=${config.provider}, model=${config.model}, runtimes=${status.length}, home=${config.dshHome}`, "info");
    },
  });

  pi.registerCommand("dsh-doctor", {
    description: "Verify the DSH ACP initialize/new/close lifecycle without a model call",
    handler: async (_args, ctx) => {
      const config = configFor(pi, ctx.cwd);
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
