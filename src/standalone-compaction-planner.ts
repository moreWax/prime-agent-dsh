/**
 * Dependency-light compaction planning. It mirrors DSH 0.1.6 policy defaults
 * (pressure threshold, retained tail, overflow retry) while leaving durable
 * mutation and summarization to the host. DSH Session users can instead adapt
 * TokenMeasurement.nodes and use dsh-compaction's pairing predicates.
 */
export type PlanningMode = "off" | "shadow" | "active";
export type PlanningTrigger = "pressure" | "context-overflow";
export interface CompactMessage {
  readonly id: string;
  readonly role: string;
  readonly content?: unknown;
  readonly sourceSeq?: number;
}
export interface CompactNode { readonly message: CompactMessage; readonly tokens: number }
export interface CompactPolicy {
  readonly mode: PlanningMode;
  readonly contextWindow: number;
  readonly thresholdRatio: number;
  readonly retainTokens: number;
  readonly maxOverflowRetries: number;
}
export interface RangeProvenance {
  readonly firstId: string; readonly lastId: string;
  readonly firstSourceSeq?: number; readonly lastSourceSeq?: number;
  readonly sourceIds: readonly string[];
}
export interface CompactRange {
  readonly start: number; readonly end: number;
  readonly tokenCount: number; readonly provenance: RangeProvenance;
  readonly marker: string;
}
export interface CompactionCandidate {
  readonly version: 1; readonly action: "compact" | "none"; readonly trigger: PlanningTrigger;
  readonly totalTokens: number; readonly thresholdTokens: number; readonly retainedTokens: number;
  readonly range?: CompactRange; readonly reason: string;
}
export interface PlanningOutcome {
  readonly mode: PlanningMode; readonly observed?: CompactionCandidate;
  /** Present only in active mode. Shadow mode is guaranteed non-mutating. */
  readonly applied?: CompactionCandidate;
  readonly error?: string;
}
export const DEFAULT_COMPACT_POLICY: CompactPolicy = Object.freeze({ mode: "off", contextWindow: 128_000,
  thresholdRatio: .8, retainTokens: 20_480, maxOverflowRetries: 1 });

export function resolveCompactPolicy(input: Partial<CompactPolicy> = {}): CompactPolicy {
  const p = { ...DEFAULT_COMPACT_POLICY, ...input };
  if (!(["off", "shadow", "active"] as const).includes(p.mode)) throw new TypeError("invalid compaction mode");
  if (!Number.isSafeInteger(p.contextWindow) || p.contextWindow <= 0 || !Number.isSafeInteger(p.retainTokens) || p.retainTokens < 0 ||
      !Number.isFinite(p.thresholdRatio) || p.thresholdRatio <= 0 || p.thresholdRatio > 1 ||
      !Number.isSafeInteger(p.maxOverflowRetries) || p.maxOverflowRetries < 0) throw new TypeError("invalid compaction policy");
  return Object.freeze(p);
}
function records(content: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(content) ? content.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
}
function callIds(message: CompactMessage): readonly string[] {
  return records(message.content).flatMap(x => (x.type === "toolCall" || x.type === "tool-call") && typeof (x.id ?? x.toolCallId) === "string" ? [String(x.id ?? x.toolCallId)] : []);
}
function resultIds(message: CompactMessage): readonly string[] {
  const own = message.role === "toolResult" && typeof (message as CompactMessage & { toolCallId?: unknown }).toolCallId === "string"
    ? [String((message as CompactMessage & { toolCallId: string }).toolCallId)] : [];
  return [...own, ...records(message.content).flatMap(x => x.type === "tool-result" && typeof x.toolCallId === "string" ? [x.toolCallId] : [])];
}
/** Return every safe cut (0..length), rejecting malformed result ordering. */
export function balancedCuts(nodes: readonly CompactNode[]): readonly number[] {
  const open = new Set<string>(), safe = [0];
  nodes.forEach((node, index) => {
    for (const id of callIds(node.message)) {
      if (open.has(id)) throw new Error(`duplicate open tool call: ${id}`);
      open.add(id);
    }
    for (const id of resultIds(node.message)) {
      if (!open.delete(id)) throw new Error(`unpaired tool result: ${id}`);
    }
    if (open.size === 0) safe.push(index + 1);
  });
  if (open.size) throw new Error(`unanswered tool call: ${[...open].sort().join(",")}`);
  return Object.freeze(safe);
}
export function provenanceMarker(p: RangeProvenance): string {
  const seq = p.firstSourceSeq === undefined ? "?" : `${p.firstSourceSeq}..${p.lastSourceSeq ?? "?"}`;
  return `[dsh-compaction source=${p.firstId}..${p.lastId} seq=${seq} count=${p.sourceIds.length}]`;
}
/** Select an old prefix while retaining a stable, whole-message recent tail. */
export function planStandaloneCompaction(nodes: readonly CompactNode[], policyInput: Partial<CompactPolicy>, trigger: PlanningTrigger,
  overflowAttempt = 0): CompactionCandidate {
  const policy = resolveCompactPolicy(policyInput), total = nodes.reduce((n, x) => {
    if (!Number.isSafeInteger(x.tokens) || x.tokens < 0) throw new TypeError(`invalid node tokens: ${x.message.id}`); return n + x.tokens;
  }, 0), threshold = Math.floor(policy.contextWindow * policy.thresholdRatio);
  const none = (reason: string): CompactionCandidate => Object.freeze({ version: 1, action: "none", trigger, totalTokens: total,
    thresholdTokens: threshold, retainedTokens: total, reason });
  if (trigger === "pressure" && total < threshold) return none("below-threshold");
  if (trigger === "context-overflow" && overflowAttempt >= policy.maxOverflowRetries) return none("overflow-retries-exhausted");
  const cuts = balancedCuts(nodes);
  let desired = nodes.length, retained = 0;
  while (desired > 0 && retained < policy.retainTokens) retained += nodes[--desired].tokens;
  // A cut at or before desired retains at least the requested stable tail.
  const tailStart = [...cuts].reverse().find(cut => cut <= desired) ?? 0;
  let start = 0;
  while (start < tailStart && nodes[start].message.role === "system") start++;
  if (start >= tailStart) return none("no-balanced-prefix");
  const end = tailStart - 1, selected = nodes.slice(start, tailStart), sourceIds = selected.map(x => x.message.id);
  const provenance: RangeProvenance = Object.freeze({ firstId: sourceIds[0], lastId: sourceIds[sourceIds.length - 1],
    ...(selected[0].message.sourceSeq === undefined ? {} : { firstSourceSeq: selected[0].message.sourceSeq }),
    ...(selected[selected.length - 1].message.sourceSeq === undefined ? {} : { lastSourceSeq: selected[selected.length - 1].message.sourceSeq }),
    sourceIds: Object.freeze(sourceIds) });
  const range: CompactRange = Object.freeze({ start, end, tokenCount: selected.reduce((n, x) => n + x.tokens, 0),
    provenance, marker: provenanceMarker(provenance) });
  return Object.freeze({ version: 1, action: "compact", trigger, totalTokens: total, thresholdTokens: threshold,
    retainedTokens: nodes.slice(tailStart).reduce((n, x) => n + x.tokens, 0), range, reason: trigger });
}

/** Mode gate and fail-open boundary. It never throws into the host model path. */
export function runCompactionPlanning(mode: PlanningMode, planner: () => CompactionCandidate): PlanningOutcome {
  if (mode === "off") return Object.freeze({ mode });
  try {
    const observed = planner();
    return Object.freeze({ mode, observed, ...(mode === "active" && observed.action === "compact" ? { applied: observed } : {}) });
  } catch (error) {
    return Object.freeze({ mode, error: error instanceof Error ? error.message : String(error) });
  }
}
