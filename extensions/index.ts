import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "../src/config.js";
import { notificationSummary } from "../src/notifications.js";
import { RuntimeManager } from "../src/runtime-manager.js";
import { dshSessionId } from "../src/session.js";

interface DshDetails {
  sessionId: string;
  state: "running" | "completed" | "failed";
  profile: string;
  provider: string;
  model: string;
  events?: number;
  notifications?: number;
  error?: string;
}

function configFor(pi: ExtensionAPI, cwd: string) {
  return loadConfig(cwd, {
    dshBin: pi.getFlag("dsh-bin") as string | undefined,
    dshHome: pi.getFlag("dsh-home") as string | undefined,
  });
}

function sessionFor(ctx: ExtensionContext, explicit?: string): string {
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
    if (typeof details?.sessionId === "string") return details.sessionId;
  }
  return dshSessionId(ctx.sessionManager.getSessionId(), ctx.sessionManager.getLeafId());
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
      let lastUpdate = "DeepSeek Harness: starting";
      onUpdate?.({
        content: [{ type: "text", text: lastUpdate }],
        details: { sessionId, state: "running", profile: config.profile, provider: config.provider, model: config.model } satisfies DshDetails,
      });
      try {
        const result = await manager.run(params.prompt, config, {
          cwd: ctx.cwd,
          sessionId,
          signal,
          onNotification(notification) {
            const summary = notificationSummary(notification);
            if (!summary || summary === lastUpdate) return;
            lastUpdate = summary;
            onUpdate?.({
              content: [{ type: "text", text: `${summary}\nSession: ${sessionId}` }],
              details: { sessionId, state: "running", profile: config.profile, provider: config.provider, model: config.model } satisfies DshDetails,
            });
          },
        });
        const details: DshDetails = { sessionId: result.sessionId, state: "completed", profile: config.profile,
          provider: config.provider, model: config.model, events: result.events.length, notifications: result.notifications.length };
        return { content: [{ type: "text", text: `${result.finalResponse || "DeepSeek Harness completed without a text response."}\n\nDSH session: ${result.sessionId}` }], details };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `DeepSeek Harness failed: ${message}\nDSH session: ${sessionId}` }],
          details: { sessionId, state: "failed", profile: config.profile, provider: config.provider, model: config.model, error: message } satisfies DshDetails,
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
        pi.sendMessage({ customType: "deepseek-harness", content: result.finalResponse || "DeepSeek Harness completed without text.", display: true,
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
    description: "Start the DSH SDK runtime and verify its initialize handshake",
    handler: async (_args, ctx) => {
      const config = configFor(pi, ctx.cwd);
      const probeSession = `doctor-${Date.now()}`;
      ctx.ui.notify(`Checking DSH ${config.profile} runtime...`, "info");
      try {
        // The official high-level API has no handshake-only facade. A minimal run tests the complete route.
        const result = await manager.run("Reply with exactly: DSH bridge OK", config, { cwd: ctx.cwd, sessionId: probeSession });
        ctx.ui.notify(`DSH bridge OK: ${result.finalResponse.slice(0, 120)}`, "info");
      } catch (error) {
        ctx.ui.notify(`DSH doctor failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
