import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
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

export const DSH_VERSION = "0.2.0";
export const PRIME_COMPATIBILITY = "Prime Agent >=0.9.5 / pi-coding-agent >=0.86.1";
export const DSH_SOURCE_URL = import.meta.url;
export const DSH_SOURCE_PATH = fileURLToPath(import.meta.url);
const CACHE_STATUS_KEY = "prime-agent-dsh-cache";
const CACHE_WIDGET_KEY = "prime-agent-dsh-cache-widget";
const INSTALLS_KEY = Symbol.for("prime-agent-dsh.installs.v1");

export function defaultCacheDisplay(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.PRIME_DSH_CACHE_DISPLAY?.trim().toLowerCase();
  return value !== "off" && value !== "false" && value !== "0";
}

type InstallRegistry = WeakSet<object>;
type GlobalWithDshInstalls = typeof globalThis & { [INSTALLS_KEY]?: InstallRegistry };

/** Process-global because separately loaded package copies do not share module state. */
export function claimExtensionApi(pi: ExtensionAPI): boolean {
  const global = globalThis as GlobalWithDshInstalls;
  const installs = global[INSTALLS_KEY] ??= new WeakSet<object>();
  if (installs.has(pi)) return false;
  installs.add(pi);
  return true;
}

function efficiencyText(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function cacheFooterText(turnEfficiency: number | null | undefined, sessionEfficiency: number | null | undefined): string {
  return `DSH cache · turn ${efficiencyText(turnEfficiency)} · session ${efficiencyText(sessionEfficiency)}`;
}

function canonicalSessionEfficiency(scope: ReturnType<RecursiveContextLoader["status"]>): number | null {
  const metrics = scope?.lastSync?.manifest.metrics;
  if (!metrics) return scope?.cache?.efficiency ?? null;
  const total = metrics.inputTokens + metrics.cacheReadTokens;
  return total > 0 ? metrics.cacheReadTokens / total : null;
}

function updateCacheStatus(ctx: ExtensionContext, loader: RecursiveContextLoader): void {
  const scope = loader.status(ctx);
  const text = cacheFooterText(scope?.latestCache?.efficiency, canonicalSessionEfficiency(scope));
  ctx.ui.setStatus(CACHE_STATUS_KEY, text);
  ctx.ui.setWidget(CACHE_WIDGET_KEY, [text], { placement: "aboveEditor" });
}

function syncAge(scope: ReturnType<RecursiveContextLoader["status"]>): string {
  if (!scope?.lastSyncAt) return "pending";
  return `${Math.max(0, Math.round((Date.now() - scope.lastSyncAt) / 1000))}s`;
}

function loadedSource(ctx: ExtensionContext): { identity: string; path: string } {
  try {
    const commands = (ctx as ExtensionContext & { getCommands?: () => Array<{ name?: string; sourceInfo?: { path?: string; source?: string; scope?: string; origin?: string } }> }).getCommands?.();
    const source = commands?.find((command) => command.name === "dsh-session")?.sourceInfo;
    if (source) {
      const identity = [source.source, source.scope, source.origin].filter(Boolean).join(":");
      return { identity: identity || DSH_SOURCE_URL, path: source.path || DSH_SOURCE_PATH };
    }
  } catch { /* Older Prime builds do not expose command provenance. */ }
  return { identity: DSH_SOURCE_URL, path: DSH_SOURCE_PATH };
}

function runtimeDetails(ctx: ExtensionContext, scope: ReturnType<RecursiveContextLoader["status"]>): string {
  const source = loadedSource(ctx);
  return `pluginVersion=${DSH_VERSION}, sourceIdentity=${source.identity}, sourcePath=${source.path}, compatibility=${PRIME_COMPATIBILITY}, lastSyncAge=${syncAge(scope)}, lastError=${scope?.lastError ?? "none"}, restart=restart Prime after install/update`;
}

/**
 * Prime owns the model loop, tools, transcript, and RLM tree. DSH contributes a
 * rebuildable context projection, immutable Python-visible artifacts, cache
 * observations. Prime alone owns compaction and DSH only indexes committed history.
 */
export default function deepSeekHarnessExtension(pi: ExtensionAPI): void {
  if (!claimExtensionApi(pi)) return;
  let showCacheDisplay = defaultCacheDisplay();
  registerShadowContextTelemetry(pi);
  const inheritance = new RlmContextInheritance();
  inheritance.register(pi);
  const contextLoader = new RecursiveContextLoader();
  contextLoader.register(pi);
  const refreshCacheDisplay = (ctx: ExtensionContext): void => {
    if (showCacheDisplay) updateCacheStatus(ctx, contextLoader);
    else {
      ctx.ui.setStatus(CACHE_STATUS_KEY, undefined);
      ctx.ui.setWidget(CACHE_WIDGET_KEY, undefined);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    await Promise.resolve();
    refreshCacheDisplay(ctx);
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

  pi.on("context", (_event, ctx) => { refreshCacheDisplay(ctx); });
  pi.on("message_end", (event, ctx) => {
    const latest = contextLoader.observeFinalizedAssistant(ctx, event.message);
    if (latest) refreshCacheDisplay(ctx);
  });
  // Re-emit native status when a daemon UI can newly attach or replace its model.
  pi.on("model_select", (_event, ctx) => { refreshCacheDisplay(ctx); });
  pi.on("session_info_changed", (_event, ctx) => { refreshCacheDisplay(ctx); });
  pi.on("session_shutdown", async (_event, ctx) => {
    await Promise.resolve();
    ctx?.ui?.setStatus?.(CACHE_STATUS_KEY, undefined);
    ctx?.ui?.setWidget?.(CACHE_WIDGET_KEY, undefined);
  });

  pi.registerCommand("dsh-cache", {
    description: "Show or hide cache-rate text; measurement remains enabled",
    handler: async (args, ctx) => {
      await Promise.resolve();
      const action = args.trim().toLowerCase();
      if (action !== "show" && action !== "hide") {
        ctx.ui.notify("Usage: /dsh-cache show | hide", "warning");
        return;
      }
      showCacheDisplay = action === "show";
      refreshCacheDisplay(ctx);
      ctx.ui.notify(`DSH cache-rate text is ${showCacheDisplay ? "shown" : "hidden"}. Measurement and indexing remain enabled.`, "info");
    },
  });

  pi.registerCommand("dsh-session", {
    description: "DSH context: on | off | status | capabilities | doctor",
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
          `DSH context: enabled=${contextLoader.isEnabled(ctx)}, cacheText=${showCacheDisplay ? "shown" : "hidden"}, inheritance=${inheritance.status(ctx).state}, loop=Prime, model=${selected}, syncs=${scope?.syncs ?? 0}, errors=${scope?.errors ?? 0}, revision=${latest?.revision ?? 0}, entries=${latest?.entryCount ?? 0}, source=${publication ? `${publication.source.mode}:${publication.source.reused}/${publication.source.new}/${publication.source.reindexed}` : "pending"}, effective=${publication ? `${publication.effective.reused}/${publication.effective.new}/${publication.effective.reindexed}` : "pending"}, effectiveReason=${publication?.effective.rebuildReason ?? "pending"}, cacheRead=${latest?.metrics.cacheReadTokens ?? 0}, cacheWrite=${latest?.metrics.cacheWriteTokens ?? 0}, ${runtimeDetails(ctx, scope)}`,
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
          ctx.ui.notify(`DSH context doctor: this session has no persistent artifact directory; context objects require a persisted Prime session. ${runtimeDetails(ctx, scope)}`, "warning");
          return;
        }
        if (scope?.lastError) {
          ctx.ui.notify(`DSH context doctor failed: ${scope.lastError} · ${runtimeDetails(ctx, scope)}`, "error");
          return;
        }
        ctx.ui.notify(
          `DSH context doctor OK · Prime loop authoritative · session=${sessionId} · root=${root} · snapshot=${scope?.lastSync?.manifest.digest ?? "pending first provider context"} · ${runtimeDetails(ctx, scope)}`,
          "info",
        );
        return;
      }
      ctx.ui.notify("Usage: /dsh-session on | off | status | capabilities | doctor", "warning");
    },
  });
}
