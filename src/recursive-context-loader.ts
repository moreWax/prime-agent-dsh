import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ContextObjectStore, type ContextObjectSyncResult } from "./context-objects.js";
import { classifyTokenPressure, measureSessionTokens, type PressureLevel, type SessionTokenBreakdown } from "./context-pressure.js";
import { ProviderCacheSeries, type ProviderCacheAggregate } from "./provider-cache-series.js";
import type { CacheEpochDiagnostics } from "./cache-epoch-diagnostics.js";

const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

interface PendingSync {
  readonly ctx: ExtensionContext;
  readonly messages?: readonly unknown[];
}

export interface SessionContextScope {
  readonly sessionId: string;
  readonly cwd: string;
  readonly bindingKey: string;
  enabled: boolean;
  disabledReason?: string;
  lastSync?: ContextObjectSyncResult;
  lastError?: string;
  syncs: number;
  errors: number;
  pressure?: { readonly level: PressureLevel; readonly measurement: SessionTokenBreakdown; readonly contextWindow: number };
  cache?: ProviderCacheAggregate;
  cacheEpoch?: CacheEpochDiagnostics;
  dirty?: boolean;
  pending?: PendingSync;
  running?: Promise<void>;
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
      await this.requestSync(ctx, scope, undefined, true);
    });
    pi.on("context", (event, ctx) => {
      const scope = this.scopeFor(ctx);
      this.measureRuntime(ctx, scope, event.messages);
      void this.requestSync(ctx, scope, event.messages, false);
      // Observation only: durable conversion and fsync run after this hook returns.
    });
    pi.on("message_end", (_event, ctx) => {
      const scope = this.scopeFor(ctx);
      void this.requestSync(ctx, scope, undefined, false);
    });
    pi.on("turn_end", async (_event, ctx) => {
      const scope = this.scopeFor(ctx);
      await this.requestSync(ctx, scope, undefined, true);
    });
    pi.on("session_compact", async (_event, ctx) => {
      const scope = this.scopeFor(ctx);
      await this.requestSync(ctx, scope, undefined, true);
    });
    pi.on("session_shutdown", async (_event, ctx) => {
      if (!ctx?.sessionManager) { this.scopes.clear(); return; }
      const sessionId = this.sessionId(ctx);
      const scope = this.scopes.get(sessionId);
      if (!scope || scope.bindingKey !== this.bindingKey(ctx)) return;
      await this.requestSync(ctx, scope, undefined, true);
      if (this.scopes.get(sessionId) === scope) this.scopes.delete(sessionId);
    });
  }

  status(ctx: ExtensionContext): Readonly<SessionContextScope> | undefined {
    return this.scopes.get(this.sessionId(ctx));
  }

  setEnabled(ctx: ExtensionContext, enabled: boolean): boolean {
    const scope = this.scopes.get(this.sessionId(ctx)) ?? this.bind(ctx);
    scope.enabled = enabled;
    if (enabled) { delete scope.disabledReason; delete scope.lastError; }
    return scope.enabled;
  }

  isEnabled(ctx: ExtensionContext): boolean {
    return this.scopes.get(this.sessionId(ctx))?.enabled ?? true;
  }

  private async requestSync(ctx: ExtensionContext, scope: SessionContextScope, messages: readonly unknown[] | undefined, wait: boolean): Promise<void> {
    if (!scope.enabled || this.scopes.get(scope.sessionId) !== scope) return;
    scope.pending = { ctx: this.detach(ctx), ...(messages === undefined ? {} : { messages: [...messages] }) };
    scope.dirty = true;
    this.startWorker(scope);
    if (wait) while (scope.running) await scope.running;
  }

  private startWorker(scope: SessionContextScope): void {
    if (scope.running || !scope.enabled) return;
    scope.running = Promise.resolve().then(async () => {
      while (scope.dirty && scope.enabled && this.scopes.get(scope.sessionId) === scope) {
        scope.dirty = false;
        const pending = scope.pending;
        if (!pending) continue;
        await this.synchronize(pending.ctx, scope, pending.messages);
      }
    }).finally(() => {
      scope.running = undefined;
      if (scope.dirty && scope.enabled && this.scopes.get(scope.sessionId) === scope) this.startWorker(scope);
    });
  }

  private async synchronize(ctx: ExtensionContext, scope: SessionContextScope, messages?: readonly unknown[]): Promise<void> {
    if (!scope.enabled || this.scopes.get(scope.sessionId) !== scope) return;
    try {
      const synced = await this.store.sync(ctx, messages);
      if (this.scopes.get(scope.sessionId) !== scope) return;
      if (synced) { scope.lastSync = synced; scope.cacheEpoch = synced.manifest.cacheEpoch; }
      scope.lastError = undefined;
      scope.syncs++;
    } catch (error) {
      if (this.scopes.get(scope.sessionId) !== scope) return;
      scope.errors++;
      const message = error instanceof Error ? error.message : String(error);
      scope.lastError = message;
      if (error instanceof Error && (error.name === "DurablePublicationUnavailableError" || "code" in error && (error as Error & { code?: string }).code === "DURABLE_PUBLICATION_UNAVAILABLE")) {
        scope.enabled = false;
        scope.disabledReason = message;
        scope.dirty = false;
        scope.pending = undefined;
      }
    }
  }

  /** Copy every host-owned value needed by deferred work while ctx is valid. */
  private detach(ctx: ExtensionContext): ExtensionContext {
    const sessionId = ctx.sessionManager.getSessionId?.() ?? "";
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    const leafId = ctx.sessionManager.getLeafId?.();
    const branch = [...(ctx.sessionManager.getBranch?.() ?? [])];
    const cwd = ctx.cwd;
    return {
      cwd,
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => sessionFile,
        getLeafId: () => leafId,
        getBranch: () => branch,
      },
    } as unknown as ExtensionContext;
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
    const usage = ctx.getContextUsage?.();
    const contextWindow = usage?.contextWindow;
    if (Number.isSafeInteger(contextWindow) && (contextWindow ?? 0) > 0) {
      scope.pressure = { level: classifyTokenPressure(measurement.surfaceTokens, contextWindow as number), measurement, contextWindow: contextWindow as number };
    } else {
      // Unknown capacity is not permission to invent a 128k window or compact.
      delete scope.pressure;
    }
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

  private bindingKey(ctx: ExtensionContext): string {
    return JSON.stringify([this.sessionId(ctx), ctx.sessionManager.getSessionFile?.() ?? "", ctx.cwd]);
  }

  private scopeFor(ctx: ExtensionContext): SessionContextScope {
    const prior = this.scopes.get(this.sessionId(ctx));
    return prior?.bindingKey === this.bindingKey(ctx) ? prior : this.bind(ctx);
  }

  private bind(ctx: ExtensionContext): SessionContextScope {
    const sessionId = this.sessionId(ctx);
    const prior = this.scopes.get(sessionId);
    const scope: SessionContextScope = { sessionId, cwd: ctx.cwd, bindingKey: this.bindingKey(ctx), enabled: prior?.enabled ?? true, syncs: 0, errors: 0 };
    this.scopes.set(sessionId, scope);
    return scope;
  }
}
