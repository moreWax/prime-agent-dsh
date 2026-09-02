import { createHash } from "node:crypto";
import { PrefixTracker, type PrefixMeasurement, stableJson } from "./prefix-metrics.js";

export type ShadowStage = "context" | "before_provider_request";
export interface ShadowLocation { sessionId: string; branchId: string; }
export interface ShadowTraceEntry extends PrefixMeasurement {
  stage: ShadowStage;
  sessionId: string;
  branchId: string;
  observedAt: string;
}
export interface ShadowStatus {
  sessionId: string;
  branchId: string;
  context?: ShadowTraceEntry;
  provider?: ShadowTraceEntry;
  observations: number;
  errors: number;
  lastError?: string;
}
interface SessionState {
  context: PrefixTracker;
  provider: PrefixTracker;
  status: ShadowStatus;
}

/**
 * Read-only telemetry for Prime's native inference path. It retains only
 * hashes/counts: provider payloads and context messages are never retained.
 */
export class ShadowContextTelemetry {
  private readonly sessions = new Map<string, SessionState>();
  private key(location: ShadowLocation): string { return location.sessionId; }
  private readonly trace: ShadowTraceEntry[] = [];
  constructor(private readonly traceLimit = 128) {}

  observe(stage: ShadowStage, payload: unknown, location: ShadowLocation): ShadowTraceEntry | undefined {
    const key = this.key(location);
    let state = this.sessions.get(key);
    if (!state) {
      state = { context: new PrefixTracker(), provider: new PrefixTracker(false), status: {
        ...location, observations: 0, errors: 0,
      }};
      this.sessions.set(key, state);
    }
    state.status.branchId = location.branchId;
    try {
      const measurement = (stage === "context" ? state.context : state.provider).measure(payload);
      const entry: ShadowTraceEntry = { ...measurement, stage, ...location, observedAt: new Date().toISOString() };
      if (stage === "context") state.status.context = entry; else state.status.provider = entry;
      state.status.observations++;
      this.trace.push(entry);
      if (this.trace.length > this.traceLimit) this.trace.splice(0, this.trace.length - this.traceLimit);
      return entry;
    } catch (error) {
      state.status.errors++;
      state.status.lastError = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }

  status(sessionId: string, branchId?: string): ShadowStatus | undefined {
    const value = branchId
      ? this.sessions.get(this.key({ sessionId, branchId }))?.status
      : [...this.sessions.values()].reverse().find((entry) => entry.status.sessionId === sessionId)?.status;
    return value ? { ...value } : undefined;
  }
  traces(sessionId?: string, limit = 20): ShadowTraceEntry[] {
    const selected = sessionId ? this.trace.filter((entry) => entry.sessionId === sessionId) : this.trace;
    return selected.slice(-Math.max(0, limit)).map((entry) => ({ ...entry }));
  }
  clear(sessionId?: string): void {
    if (sessionId) {
      for (const [key, value] of this.sessions) if (value.status.sessionId === sessionId) this.sessions.delete(key);
    } else this.sessions.clear();
    for (let index = this.trace.length - 1; index >= 0; index--) {
      if (!sessionId || this.trace[index]?.sessionId === sessionId) this.trace.splice(index, 1);
    }
  }
}

export function shortFingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 12);
}
