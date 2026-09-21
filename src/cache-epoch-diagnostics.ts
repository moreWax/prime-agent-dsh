import { createHash } from "node:crypto";

export interface ProviderUsageCounters {
  readonly inputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface CacheEpochUsageSample extends ProviderUsageCounters {
  readonly sourceIndex: number;
  readonly phase: "firstAfterCompaction" | "stable";
}

export interface CacheEpochDiagnostics {
  readonly version: 1;
  readonly epochId: string;
  readonly boundaryId?: string;
  readonly boundarySourceIndex?: number;
  readonly summaryRequest?: ProviderUsageCounters;
  readonly firstAfterCompaction?: CacheEpochUsageSample;
  readonly stableSampleCount: number;
  /** Bounded tail of steady-state samples. */
  readonly stable: readonly CacheEpochUsageSample[];
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

export function providerUsageCounters(value: unknown): ProviderUsageCounters | undefined {
  const usage = object(value);
  if (!usage) return undefined;
  const counters = { inputTokens: count(usage.input), cacheReadTokens: count(usage.cacheRead), cacheWriteTokens: count(usage.cacheWrite) };
  return Object.values(counters).some((item) => item !== undefined) ? counters : undefined;
}

/** Derive content-free cache evidence from durable Prime entries. */
export function cacheEpochFromBranch(sessionId: string, branch: readonly unknown[]): CacheEpochDiagnostics {
  let boundary: JsonObject | undefined;
  let boundarySourceIndex: number | undefined;
  branch.forEach((raw, index) => { const entry = object(raw); if (entry?.type === "compaction") { boundary = entry; boundarySourceIndex = index; } });
  const boundaryId = typeof boundary?.id === "string" ? boundary.id : undefined;
  const details = object(boundary?.details);
  const recordedEpoch = typeof details?.cacheEpochId === "string" && /^[a-f0-9]{64}$/.test(details.cacheEpochId) ? details.cacheEpochId : undefined;
  const epochId = recordedEpoch ?? createHash("sha256").update(`${sessionId}\0${boundaryId ?? "initial"}`).digest("hex");
  const start = boundarySourceIndex === undefined ? -1 : boundarySourceIndex;
  const samples: CacheEpochUsageSample[] = [];
  for (let index = start + 1; index < branch.length; index++) {
    const entry = object(branch[index]);
    const message = object(entry?.message);
    if (entry?.type !== "message" || message?.role !== "assistant") continue;
    const usage = providerUsageCounters(message.usage);
    if (!usage) continue;
    samples.push({ sourceIndex: index, phase: samples.length === 0 && boundary ? "firstAfterCompaction" : "stable", ...usage });
  }
  return Object.freeze({ version: 1 as const, epochId, ...(boundaryId ? { boundaryId } : {}),
    ...(boundarySourceIndex === undefined ? {} : { boundarySourceIndex }),
    ...(providerUsageCounters(boundary?.usage) ? { summaryRequest: providerUsageCounters(boundary?.usage) } : {}),
    ...(boundary && samples[0] ? { firstAfterCompaction: samples[0] } : {}),
    stableSampleCount: samples.length - (boundary && samples.length ? 1 : 0),
    stable: Object.freeze(samples.slice(boundary ? 1 : 0).slice(-32)),
  });
}
