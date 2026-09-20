import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ContextObjectStore, type ContextObjectSyncResult } from "./context-objects.js";
import { classifyTokenPressure, measureSessionTokens, type PressureLevel, type SessionTokenBreakdown } from "./context-pressure.js";
import { ProviderCacheSeries, type ProviderCacheAggregate } from "./provider-cache-series.js";

const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

export interface SessionContextScope {
  readonly sessionId: string;
  readonly cwd: string;
  enabled: boolean;
  lastSync?: ContextObjectSyncResult;
  lastError?: string;
  syncs: number;
  errors: number;
  pressure?: { readonly level: PressureLevel; readonly measurement: SessionTokenBreakdown; readonly contextWindow: number };
  cache?: ProviderCacheAggregate;
}

/**
 * Binds one derived DSH context scope to every Prime AgentSession, including
 * independently rebound RLM descendants. Prime remains the only loop and log
 * authority; scopes contain rebuildable projections and private artifacts.
 */
export class RecursiveContextLoader {
  private readonly scopes = new Map<string, SessionContextScope>();

  constructor(private readonly store = new ContextObjectStore()) {}

  register(pi: Pick<ExtensionAPI, "on">): void {
    pi.on("session_start", async (_event, ctx) => {
      const scope = this.bind(ctx);
      await this.synchronize(ctx, scope);
    });
    pi.on("context", async (event, ctx) => {
      const scope = this.scopes.get(this.sessionId(ctx)) ?? this.bind(ctx);
      await this.synchronize(ctx, scope, event.messages);
      // Observation only: returning no replacement preserves Prime's exact Context.
    });
    pi.on("session_shutdown", async (_event, ctx) => {
      await Promise.resolve();
      if (ctx?.sessionManager) this.scopes.delete(this.sessionId(ctx));
      else this.scopes.clear();
    });
  }

  status(ctx: ExtensionContext): Readonly<SessionContextScope> | undefined {
    return this.scopes.get(this.sessionId(ctx));
  }

  setEnabled(ctx: ExtensionContext, enabled: boolean): boolean {
    const scope = this.scopes.get(this.sessionId(ctx)) ?? this.bind(ctx);
    scope.enabled = enabled;
    return scope.enabled;
  }

  isEnabled(ctx: ExtensionContext): boolean {
    return this.scopes.get(this.sessionId(ctx))?.enabled ?? true;
  }

  private async synchronize(ctx: ExtensionContext, scope: SessionContextScope, messages?: readonly unknown[]): Promise<void> {
    if (!scope.enabled) return;
    try {
      const observed = messages ?? this.sessionMessages(ctx);
      this.measureRuntime(ctx, scope, observed);
      const synced = await this.store.sync(ctx, messages);
      if (synced) scope.lastSync = synced;
      scope.lastError = undefined;
      scope.syncs++;
    } catch (error) {
      scope.errors++;
      const message = error instanceof Error ? error.message : String(error);
      if (scope.lastError !== message) ctx.ui?.notify?.(`DSH context snapshot failed open: ${message}`, "warning");
      scope.lastError = message;
    }
  }

  private sessionMessages(ctx: ExtensionContext): readonly unknown[] {
    const manager = ctx.sessionManager as typeof ctx.sessionManager & { buildSessionContext?: () => { messages?: readonly unknown[] } };
    try { const built = manager.buildSessionContext?.(); return Array.isArray(built?.messages) ? built.messages : []; }
    catch { return []; }
  }

  /** Rebuild on every native context event, so retries/replays never double count. */
  private measureRuntime(ctx: ExtensionContext, scope: SessionContextScope, input: readonly unknown[]): void {
    const messages = input.flatMap((raw, index) => {
      if (!raw || typeof raw !== "object") return [];
      const value = raw as Record<string, unknown>;
      const usage = value.usage && typeof value.usage === "object" ? value.usage as Record<string, unknown> : undefined;
      return [{ id: typeof value.id === "string" ? value.id : `context-${index}`, role: typeof value.role === "string" ? value.role : "unknown",
        content: value.content, ...(usage ? { usage: { input: number(usage.input), output: number(usage.output), cacheRead: number(usage.cacheRead), cacheWrite: number(usage.cacheWrite) } } : {}) }];
    });
    const measurement = measureSessionTokens(messages);
    const model = ctx.model as (typeof ctx.model & { contextWindow?: number }) | undefined;
    const reportedWindow = model?.contextWindow;
    const contextWindow = Number.isSafeInteger(reportedWindow) && (reportedWindow ?? 0) > 0 ? reportedWindow as number : 128_000;
    scope.pressure = { level: classifyTokenPressure(measurement.surfaceTokens, contextWindow), measurement, contextWindow };
    const series = new ProviderCacheSeries();
    let request = 0;
    for (const message of messages) if (message.role === "assistant" && message.usage) {
      request++; series.add({ request, inputTokens: message.usage.input, cacheReadTokens: message.usage.cacheRead, cacheWriteTokens: message.usage.cacheWrite });
    }
    scope.cache = series.aggregate();
  }

  private sessionId(ctx: ExtensionContext): string {
    return ctx.sessionManager.getSessionId?.() ?? ctx.cwd;
  }

  private bind(ctx: ExtensionContext): SessionContextScope {
    const sessionId = this.sessionId(ctx);
    const prior = this.scopes.get(sessionId);
    const scope: SessionContextScope = { sessionId, cwd: ctx.cwd, enabled: prior?.enabled ?? true, syncs: 0, errors: 0 };
    this.scopes.set(sessionId, scope);
    return scope;
  }
}
