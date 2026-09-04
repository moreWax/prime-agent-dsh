import type { CompactionResult, ExtensionAPI, SessionBeforeCompactEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";

type AgentMessage = SessionBeforeCompactEvent["preparation"]["messagesToSummarize"][number];

export type CompactionMode = "off" | "shadow" | "active";

export interface ToolResultPrunePolicy {
  readonly thresholdChars: number;
  readonly headChars: number;
  readonly tailChars: number;
}

export interface CompactionPlannerConfig {
  readonly mode: CompactionMode;
  readonly pruning: ToolResultPrunePolicy;
}

export interface ToolResultPruneFact {
  readonly toolCallId: string;
  readonly charsBefore: number;
  readonly charsAfter: number;
}

export interface CompactionPlan {
  readonly version: 1;
  readonly reason: SessionBeforeCompactEvent["reason"];
  readonly firstKeptEntryId: string;
  readonly tokensBefore: number;
  readonly isSplitTurn: boolean;
  readonly summarizedMessageCount: number;
  readonly retainedPrefixMessageCount: number;
  readonly pruned: readonly ToolResultPruneFact[];
  readonly charsRemoved: number;
  readonly preparation: SessionBeforeCompactEvent["preparation"];
}

export interface CompactionPlannerDiagnostics {
  readonly plans: number;
  readonly active: number;
  readonly failures: number;
  readonly lastPlan?: CompactionPlan;
  readonly lastError?: string;
}

export const DSH_PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";
export const DEFAULT_PRUNE_POLICY: ToolResultPrunePolicy = Object.freeze({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 });

function checkedPositive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

export function resolvePrunePolicy(policy: Partial<ToolResultPrunePolicy> = {}): ToolResultPrunePolicy {
  const resolved = {
    thresholdChars: checkedPositive(policy.thresholdChars ?? DEFAULT_PRUNE_POLICY.thresholdChars, "thresholdChars"),
    headChars: checkedPositive(policy.headChars ?? DEFAULT_PRUNE_POLICY.headChars, "headChars"),
    tailChars: checkedPositive(policy.tailChars ?? DEFAULT_PRUNE_POLICY.tailChars, "tailChars"),
  };
  if (resolved.headChars + resolved.tailChars + Array.from(DSH_PRUNE_MARKER).length > resolved.thresholdChars) {
    throw new TypeError("headChars + tailChars + prune marker must not exceed thresholdChars");
  }
  return Object.freeze(resolved);
}

function pruneTextBlocks<T extends { readonly type: string }>(blocks: readonly T[], policy: ToolResultPrunePolicy): T[] | null {
  const textBlocks = blocks.filter((block): block is T & { readonly type: "text"; readonly text: string } =>
    block.type === "text" && typeof (block as { text?: unknown }).text === "string");
  const total = textBlocks.reduce((sum, block) => sum + Array.from(block.text).length, 0);
  if (total <= policy.thresholdChars) return null;
  const removedStart = policy.headChars;
  const removedEnd = total - policy.tailChars;
  let consumed = 0;
  let inserted = false;
  return blocks.flatMap((block) => {
    if (block.type !== "text" || typeof (block as { text?: unknown }).text !== "string") return [block];
    const textBlock = block as T & { readonly text: string };
    const points = Array.from(textBlock.text);
    const start = consumed;
    const end = start + points.length;
    const headEnd = Math.min(points.length, Math.max(0, removedStart - start));
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - start));
    const marker = start < removedEnd && end > removedStart && !inserted ? DSH_PRUNE_MARKER : "";
    if (marker) inserted = true;
    consumed = end;
    const text = points.slice(0, headEnd).join("") + marker + points.slice(tailStart).join("");
    return text ? [{ ...textBlock, text }] : [];
  });
}

export function pruneToolResults(inputMessages: readonly AgentMessage[], policyInput: Partial<ToolResultPrunePolicy> = {}): {
  readonly messages: AgentMessage[]; readonly facts: ToolResultPruneFact[]; readonly charsRemoved: number;
} {
  const policy = resolvePrunePolicy(policyInput);
  const facts: ToolResultPruneFact[] = [];
  const messages = inputMessages.map((message): AgentMessage => {
    if (!("role" in message) || message.role !== "toolResult") return message;
    const before = message.content.reduce((sum, block) => sum + (block.type === "text" ? Array.from(block.text).length : 0), 0);
    const content = pruneTextBlocks(message.content, policy);
    if (!content) return message;
    const after = content.reduce((sum, block) => sum + (block.type === "text" ? Array.from(block.text).length : 0), 0);
    facts.push(Object.freeze({ toolCallId: message.toolCallId, charsBefore: before, charsAfter: after }));
    return { ...message, content };
  });
  return { messages, facts, charsRemoved: facts.reduce((sum, fact) => sum + fact.charsBefore - fact.charsAfter, 0) };
}


export function loadCompactionPlannerConfig(modeValue = process.env.PRIME_DSH_COMPACTION_MODE): CompactionPlannerConfig {
  const mode = modeValue?.trim() || "off";
  if (mode !== "off" && mode !== "shadow" && mode !== "active") throw new TypeError("PRIME_DSH_COMPACTION_MODE must be off, shadow, or active");
  const envInteger = (name: string, fallback: number): number => {
    const raw = process.env[name];
    return raw === undefined || raw === "" ? fallback : checkedPositive(Number(raw), name);
  };
  return Object.freeze({ mode, pruning: resolvePrunePolicy({
    thresholdChars: envInteger("PRIME_DSH_PRUNE_THRESHOLD_CHARS", DEFAULT_PRUNE_POLICY.thresholdChars),
    headChars: envInteger("PRIME_DSH_PRUNE_HEAD_CHARS", DEFAULT_PRUNE_POLICY.headChars),
    tailChars: envInteger("PRIME_DSH_PRUNE_TAIL_CHARS", DEFAULT_PRUNE_POLICY.tailChars),
  }) });
}

/** Pure DSH-style plan: preserve Prime's balanced durable cut and prune only its summarized region. */
export function planCompaction(event: SessionBeforeCompactEvent, policy: Partial<ToolResultPrunePolicy> = {}): CompactionPlan {
  const pruned = pruneToolResults(event.preparation.messagesToSummarize, policy);
  return Object.freeze({
    version: 1, reason: event.reason, firstKeptEntryId: event.preparation.firstKeptEntryId,
    tokensBefore: event.preparation.tokensBefore, isSplitTurn: event.preparation.isSplitTurn,
    summarizedMessageCount: pruned.messages.length, retainedPrefixMessageCount: event.preparation.turnPrefixMessages.length,
    pruned: Object.freeze(pruned.facts), charsRemoved: pruned.charsRemoved,
    preparation: { ...event.preparation, messagesToSummarize: pruned.messages },
  });
}

export type PrimeCompactor = (event: SessionBeforeCompactEvent, ctx: ExtensionContext, plan: CompactionPlan) => Promise<CompactionResult>;

/** Registers exclusively on Prime's durable compaction seam; shadow mode never returns a mutation. */
export class DurableCompactionController {
  private state: CompactionPlannerDiagnostics = { plans: 0, active: 0, failures: 0 };
  constructor(private readonly config: CompactionPlannerConfig, private readonly compact: PrimeCompactor) {}
  diagnostics(): CompactionPlannerDiagnostics { return this.state; }
  register(pi: ExtensionAPI): void {
    if (this.config.mode === "off") return;
    pi.on("session_before_compact", async (event, ctx) => {
      try {
        const plan = planCompaction(event, this.config.pruning);
        this.state = { ...this.state, plans: this.state.plans + 1, lastPlan: plan, lastError: undefined };
        if (this.config.mode === "shadow") return;
        const compaction = await this.compact(event, ctx, plan);
        this.state = { ...this.state, active: this.state.active + 1 };
        return { compaction };
      } catch (error) {
        this.state = { ...this.state, failures: this.state.failures + 1, lastError: error instanceof Error ? error.message : String(error) };
        return;
      }
    });
  }
}
