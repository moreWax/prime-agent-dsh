import type { ContextUsage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { contextObjectRoot } from "../src/context-objects.js";
import { RecursiveContextLoader } from "../src/recursive-context-loader.js";
import { RlmContextInheritance } from "../src/rlm-context-bootstrap.js";
import { registerShadowContextTelemetry } from "./shadow-context.js";

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
    return ageMinutes <= 720 ? { id: best.id, ageMinutes } : undefined;
  } catch {
    return undefined;
  }
}

const CACHE_STATUS_KEY = "prime-agent-dsh-cache";

export function compactTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(Math.round(value));
}

export function cacheFooterText(efficiency: number | null | undefined, usage: ContextUsage | undefined): string {
  const cache = efficiency === null || efficiency === undefined ? "—" : `${(efficiency * 100).toFixed(1)}%`;
  const tokens = usage?.tokens;
  const window = usage?.contextWindow;
  const context = tokens === null || tokens === undefined || window === undefined
    ? "—"
    : `${compactTokenCount(tokens)}/${compactTokenCount(window)}`;
  const percent = usage?.percent === null || usage?.percent === undefined ? "—" : `${usage.percent.toFixed(1)}%`;
  return `DSH cache ${cache} · ctx ${context} · ${percent}`;
}

function updateCacheStatus(ctx: ExtensionContext, loader: RecursiveContextLoader): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(CACHE_STATUS_KEY, cacheFooterText(loader.status(ctx)?.latestCache?.efficiency, ctx.getContextUsage()));
}

/**
 * Prime owns the model loop, tools, transcript, and RLM tree. DSH contributes a
 * rebuildable context projection, immutable Python-visible artifacts, cache
 * observations. Prime alone owns compaction and DSH only indexes committed history.
 */
export default function deepSeekHarnessExtension(pi: ExtensionAPI): void {
  registerShadowContextTelemetry(pi);
  const inheritance = new RlmContextInheritance();
  inheritance.register(pi);
  const contextLoader = new RecursiveContextLoader();
  contextLoader.register(pi);

  pi.on("session_start", async (_event, ctx) => {
    await Promise.resolve();
    updateCacheStatus(ctx, contextLoader);
    if (!ctx.hasUI) return;
    const modelLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
    const state = contextLoader.isEnabled(ctx) ? "on" : "off";
    const inherited = inheritance.status(ctx);
    const inheritanceLabel = inherited.state === "admitted" ? `admitted generation ${inherited.capsule.generation}` : inherited.state;
    const inheritanceNotice = inheritanceLabel;
    const messages = committedMessages(ctx);
    if (messages > 0) {
      ctx.ui.notify(`Session resumed (${messages} messages) · DSH context ${state} · inheritance ${inheritanceNotice} · Prime loop · model ${modelLabel}`, inherited.state === "degraded" || inherited.state === "incompatible" ? "warning" : "info");
      return;
    }
    const sibling = recentSiblingSession(ctx);
    const hint = sibling ? ` · a session from ${sibling.ageMinutes} min ago exists — resume it to keep context` : "";
    ctx.ui.notify(`Fresh session · DSH context ${state} · inheritance ${inheritanceNotice} · Prime loop · model ${modelLabel}${hint}`, inherited.state === "degraded" || inherited.state === "incompatible" ? "warning" : "info");
  });

  pi.on("context", (_event, ctx) => { updateCacheStatus(ctx, contextLoader); });
  pi.on("session_shutdown", async (_event, ctx) => {
    await Promise.resolve();
    if (ctx.hasUI) ctx.ui.setStatus(CACHE_STATUS_KEY, undefined);
  });

  pi.registerCommand("dsh-session", {
    description: "DSH context for this session: on | off | status | capabilities | doctor",
    handler: async (args, ctx) => {
      await Promise.resolve();
      const verb = args.trim().toLowerCase();
      if (verb === "on") {
        contextLoader.setEnabled(ctx, true);
        ctx.ui.notify("DSH context objects are enabled for this Prime session.", "info");
        return;
      }
      if (verb === "off") {
        contextLoader.setEnabled(ctx, false);
        ctx.ui.notify("DSH context objects are disabled for this Prime session. Prime inference remains native.", "info");
        return;
      }
      if (verb === "status" || verb === "") {
        const scope = contextLoader.status(ctx);
        const latest = scope?.lastSync?.manifest;
        const selected = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
        const publication = latest?.publication;
        ctx.ui.notify(
          `DSH context: enabled=${contextLoader.isEnabled(ctx)}, inheritance=${inheritance.status(ctx).state}, loop=Prime, model=${selected}, syncs=${scope?.syncs ?? 0}, errors=${scope?.errors ?? 0}, revision=${latest?.revision ?? 0}, entries=${latest?.entryCount ?? 0}, source=${publication ? `${publication.source.mode}:${publication.source.reused}/${publication.source.new}/${publication.source.reindexed}` : "pending"}, effective=${publication ? `${publication.effective.reused}/${publication.effective.new}/${publication.effective.reindexed}` : "pending"}, effectiveReason=${publication?.effective.rebuildReason ?? "pending"}, cacheRead=${latest?.metrics.cacheReadTokens ?? 0}, cacheWrite=${latest?.metrics.cacheWriteTokens ?? 0}`,
          scope?.lastError ? "warning" : "info",
        );
        return;
      }
      if (verb === "capabilities") {
        ctx.ui.notify(
          "DSH context capabilities: per-root/child isolation, native automatic bounded RLM inheritance, DSH Session projection, immutable snapshots, bounded search/messages, private artifacts, provider-reported cache metrics, durable IPython admission, and expiring parent-to-child grants. Prime remains the sole model/tool loop.",
          "info",
        );
        return;
      }
      if (verb === "doctor") {
        const sessionId = ctx.sessionManager.getSessionId?.() ?? "";
        const sessionFile = ctx.sessionManager.getSessionFile?.();
        const root = contextObjectRoot(sessionId, sessionFile);
        const scope = contextLoader.status(ctx);
        if (!sessionId || !sessionFile || !root) {
          ctx.ui.notify("DSH context doctor: this session has no persistent artifact directory; context objects require a persisted Prime session.", "warning");
          return;
        }
        if (scope?.lastError) {
          ctx.ui.notify(`DSH context doctor failed: ${scope.lastError}`, "error");
          return;
        }
        ctx.ui.notify(
          `DSH context doctor OK · Prime loop authoritative · session=${sessionId} · root=${root} · snapshot=${scope?.lastSync?.manifest.digest ?? "pending first provider context"}`,
          "info",
        );
        return;
      }
      ctx.ui.notify("Usage: /dsh-session on | off | status | capabilities | doctor", "warning");
    },
  });
}
