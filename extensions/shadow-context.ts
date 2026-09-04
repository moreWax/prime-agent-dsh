import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@deepseek-ai/dsh-llm";
import { ShadowContextTelemetry, type ShadowLocation, type ShadowTraceEntry } from "../src/shadow-telemetry.js";
import { ContextService } from "../src/dsh-context-service.js";
import { PROTOCOL, type Failure, type Success } from "../src/context-protocol.js";
import { primeToDsh, dshToPrime, type PrimeEnvelope, type PrimeMessage } from "../src/context-converter.js";
import { stableJson } from "../src/prefix-metrics.js";

interface MirrorCounters {
  syncs: number;
  skips: number;
  errors: number;
  appends: number;
  noops: number;
  rebuilds: number;
}
interface SyncResult { revision: number; messageCount: number; mode: "append" | "noop" | "rebuild"; }
interface ProjectResult { messages: Message[]; }
type ServiceResponse = Success | Failure;

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
function asPrimeInput(value: unknown): PrimeMessage | PrimeEnvelope {
  if (!isObject(value)) throw new TypeError("Prime context message must be an object");
  if (isObject(value.message) && typeof value.message.role === "string") return value as PrimeEnvelope;
  if (typeof value.role === "string") return value as PrimeMessage;
  throw new TypeError("Prime context message has no role");
}
function isSyncResult(value: unknown): value is SyncResult {
  return isObject(value) && typeof value.revision === "number" && typeof value.messageCount === "number"
    && (value.mode === "append" || value.mode === "noop" || value.mode === "rebuild");
}
function isProjectResult(value: unknown): value is ProjectResult {
  return isObject(value) && Array.isArray(value.messages);
}

function location(ctx: ExtensionContext): ShadowLocation {
  return { sessionId: ctx.sessionManager.getSessionId(), branchId: ctx.sessionManager.getLeafId() ?? "root" };
}
function metric(entry: ShadowTraceEntry | undefined): string {
  if (!entry) return "none";
  return `#${entry.request} ${entry.bytes}B sha256:${entry.digest.slice(0, 12)} lcp=${entry.commonPrefixBytes}B (${(entry.prefixRatio * 100).toFixed(1)}%) ${entry.reason}`;
}

/** Owns the fail-open DSH mirror lifecycle and typed protocol boundary. */
export class ShadowMirrorController {
  private readonly service: ContextService;
  private requestId = 1;
  private readonly revisions = new Map<string, number>();
  readonly counters: MirrorCounters = { syncs: 0, skips: 0, errors: 0, appends: 0, noops: 0, rebuilds: 0 };

  constructor(service = new ContextService()) {
    this.service = service;
    const initialized = this.call("initialize");
    if (!initialized.ok) throw new Error(`Could not initialize context shadow: ${initialized.error.message}`);
  }

  observe(messages: readonly unknown[], sessionId: string): void {
    try {
      const canonical = messages.map((message, index) => primeToDsh(asPrimeInput(message), {}, this.messageId(message, index)));
      const synced = this.call("session/sync-canonical", { sessionId, messages: canonical, expectedRevision: this.revisions.get(sessionId) ?? 0 });
      if (!synced.ok || !isSyncResult(synced.result)) { this.counters.errors++; return; }
      const projected = this.call("project", { sessionId });
      if (!projected.ok || !isProjectResult(projected.result)) { this.counters.errors++; return; }
      const roundTrip = projected.result.messages.map((message) => dshToPrime(message));
      if (stableJson(roundTrip) !== stableJson(messages)) { this.counters.skips++; return; }
      this.revisions.set(sessionId, synced.result.revision);
      this.counters.syncs++;
      if (synced.result.mode === "append") this.counters.appends++;
      else if (synced.result.mode === "noop") this.counters.noops++;
      else this.counters.rebuilds++;
    } catch { this.counters.errors++; }
  }

  private messageId(message: unknown, index: number): string {
    return `prime-${createHash("sha256").update(`${index}:`).update(stableJson(message)).digest("hex").slice(0, 32)}`;
  }
  private call(method: string, params?: unknown): ServiceResponse {
    return this.service.handle({ version: PROTOCOL, id: ++this.requestId, method, params });
  }
}

/** Registers passive observers and owns their command-facing presentation. */
export class ShadowContextExtension {
  readonly telemetry: ShadowContextTelemetry;
  readonly mirror: ShadowMirrorController;

  constructor(private readonly pi: ExtensionAPI, telemetry = new ShadowContextTelemetry(), mirror = new ShadowMirrorController()) {
    this.telemetry = telemetry;
    this.mirror = mirror;
  }

  register(): ShadowContextTelemetry {
    this.pi.on("context", (event, ctx) => {
      const here = location(ctx);
      this.telemetry.observe("context", event.messages, here);
      this.mirror.observe(event.messages, here.sessionId);
    });
    this.pi.on("before_provider_request", (event, ctx) => {
      this.telemetry.observe("before_provider_request", event.payload, location(ctx));
    });
    this.registerStatusCommand();
    this.registerTraceCommand();
    return this.telemetry;
  }

  private registerStatusCommand(): void {
    this.pi.registerCommand("dsh-context-status", {
      description: "Show passive Prime context/provider prefix telemetry",
      handler: async (_args, ctx) => {
        const here = location(ctx);
        const status = this.telemetry.status(here.sessionId, here.branchId) ?? this.telemetry.status(here.sessionId);
        if (!status) { ctx.ui.notify(`DSH context shadow: no observations for session ${here.sessionId}`, "info"); return; }
        const c = this.mirror.counters;
        ctx.ui.notify(`DSH context shadow session=${status.sessionId} branch=${status.branchId} observations=${status.observations} errors=${status.errors}
context ${metric(status.context)}
provider ${metric(status.provider)}
DSH mirror syncs=${c.syncs} append=${c.appends} noop=${c.noops} rebuild=${c.rebuilds} skips=${c.skips} errors=${c.errors}`, status.errors || c.errors ? "warning" : "info");
      },
    });
  }

  private registerTraceCommand(): void {
    this.pi.registerCommand("dsh-context-trace", {
      description: "Show or clear passive context fingerprint trace (/dsh-context-trace [count|clear])",
      handler: async (args, ctx) => {
        const here = location(ctx);
        const arg = args.trim().toLowerCase();
        if (arg === "clear") { this.telemetry.clear(here.sessionId); ctx.ui.notify("DSH context shadow trace cleared for this session", "info"); return; }
        const requested = arg ? Number.parseInt(arg, 10) : 10;
        const count = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 50) : 10;
        const entries = this.telemetry.traces(here.sessionId, count);
        const text = entries.length ? entries.map((entry) => `${entry.observedAt} branch=${entry.branchId} ${entry.stage} ${metric(entry)}`).join("\n") : "No context shadow trace observations.";
        ctx.ui.notify(text, "info");
      },
    });
  }
}

/** Compatibility entry point used by the package extension. */
export function registerShadowContextTelemetry(pi: ExtensionAPI): ShadowContextTelemetry {
  return new ShadowContextExtension(pi).register();
}
