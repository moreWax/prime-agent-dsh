import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { RecursiveContextLoader } from "../src/recursive-context-loader.js";
import { RlmContextInheritance } from "../src/rlm-context-bootstrap.js";
import { ShadowContextExtension } from "./shadow-context.js";

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

export const DSH_VERSION = "0.2.3";
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

/**
 * Prime owns the model loop, tools, transcript, and RLM tree. DSH contributes a
 * rebuildable context projection, immutable Python-visible artifacts, cache
 * observations. Prime alone owns compaction and DSH only indexes committed history.
 */
export default function deepSeekHarnessExtension(pi: ExtensionAPI): void {
  if (!claimExtensionApi(pi)) return;
  let showCacheDisplay = defaultCacheDisplay();
  new ShadowContextExtension(pi).register(false);
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

  pi.registerCommand("dsh", {
    description: "Toggle DSH cache-rate text, set visibility, or show help",
    handler: async (args, ctx) => {
      await Promise.resolve();
      const action = args.trim().toLowerCase();
      if (action === "help") {
        ctx.ui.notify([
          "DSH commands:",
          "/dsh — toggle cache-rate text and report the resulting state",
          "/dsh show — show cache-rate text",
          "/dsh hide — hide cache-rate text",
          "/dsh help — show this help",
          "Display controls do not disable indexing or provider cache measurement.",
        ].join("\n"), "info");
        return;
      }
      if (action === "") showCacheDisplay = !showCacheDisplay;
      else if (action === "show") showCacheDisplay = true;
      else if (action === "hide") showCacheDisplay = false;
      else {
        ctx.ui.notify("Usage: /dsh [show|hide|help]", "warning");
        return;
      }
      refreshCacheDisplay(ctx);
      const scope = contextLoader.status(ctx);
      const rates = cacheFooterText(scope?.latestCache?.efficiency, canonicalSessionEfficiency(scope)).replace(/^DSH cache · /u, "");
      ctx.ui.notify(
        `DSH ${DSH_VERSION} · cache text ${showCacheDisplay ? "ON" : "OFF"} · indexing ${contextLoader.isEnabled(ctx) ? "ACTIVE" : "PAUSED"} · ${rates}`,
        scope?.lastError ? "warning" : "info",
      );
    },
  });

}
