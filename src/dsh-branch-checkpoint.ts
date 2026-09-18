import { createHash } from "node:crypto";

export const DSH_CHECKPOINT_CUSTOM_TYPE = "prime-agent-dsh/checkpoint";

export interface DshBranchCheckpointV1 {
  readonly version: 1;
  readonly primeSessionId: string;
  readonly primeTurnEntryId: string;
  readonly dshSessionId: string;
  /** Inclusive sequence of the DSH `turn/end` event. */
  readonly dshBoundarySeq: number;
  readonly outcome: "stop" | "incomplete";
}

export interface PrimeBranchEntry {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly parentId?: unknown;
  readonly customType?: unknown;
  readonly data?: unknown;
  readonly message?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDshSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

/** Parse checkpoint data without trusting values read from a Prime session file. */
export function parseDshBranchCheckpoint(data: unknown): DshBranchCheckpointV1 | undefined {
  if (!isRecord(data) || data.version !== 1) return undefined;
  if (!isNonEmptyString(data.primeSessionId)) return undefined;
  if (!isNonEmptyString(data.primeTurnEntryId)) return undefined;
  if (!isDshSessionId(data.dshSessionId)) return undefined;
  if (!Number.isSafeInteger(data.dshBoundarySeq) || (data.dshBoundarySeq as number) < 0) return undefined;
  if (data.outcome !== "stop" && data.outcome !== "incomplete") return undefined;

  return {
    version: 1,
    primeSessionId: data.primeSessionId,
    primeTurnEntryId: data.primeTurnEntryId,
    dshSessionId: data.dshSessionId,
    dshBoundarySeq: data.dshBoundarySeq as number,
    outcome: data.outcome,
  };
}

/** Parse only plain Prime custom entries whose tree parent is the recorded turn. */
export function parseDshBranchCheckpointEntry(entry: unknown): DshBranchCheckpointV1 | undefined {
  if (!isRecord(entry)) return undefined;
  if (entry.type !== "custom" || entry.customType !== DSH_CHECKPOINT_CUSTOM_TYPE) return undefined;
  const checkpoint = parseDshBranchCheckpoint(entry.data);
  if (!checkpoint || entry.parentId !== checkpoint.primeTurnEntryId) return undefined;
  return checkpoint;
}

/** Find the nearest usable checkpoint on the active root-to-leaf Prime branch. */
export function findNearestDshBranchCheckpoint(
  branch: readonly unknown[],
): DshBranchCheckpointV1 | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const checkpoint = parseDshBranchCheckpointEntry(branch[index]);
    if (checkpoint) return checkpoint;
  }
  return undefined;
}

/** Find the current (latest persisted) Prime user-message entry on a branch. */
export function findLatestPrimeUserEntryId(branch: readonly unknown[]): string | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (!isRecord(entry) || entry.type !== "message" || !isNonEmptyString(entry.id)) continue;
    if (isRecord(entry.message) && entry.message.role === "user") return entry.id;
  }
  return undefined;
}

function deterministicSessionId(parts: readonly (string | number)[]): string {
  const digest = createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 32);
  return `pi-${digest}`;
}

/** Stable base DSH ID for a Prime turn which has no checkpoint ancestor. */
export function deriveBaseDshSessionId(primeSessionId: string, primeTurnEntryId: string): string {
  return deterministicSessionId(["base", primeSessionId, primeTurnEntryId]);
}

/** Stable fork ID. Retries converge while sibling Prime branches remain distinct. */
export function deriveForkedDshSessionId(
  primeSessionId: string,
  primeTurnEntryId: string,
  sourceDshSessionId: string,
  sourceBoundarySeq: number,
): string {
  return deterministicSessionId([
    "fork",
    primeSessionId,
    primeTurnEntryId,
    sourceDshSessionId,
    sourceBoundarySeq,
  ]);
}
