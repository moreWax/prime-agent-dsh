/**
 * Standalone request-pressure accounting.
 *
 * The adapter boundary intentionally matches the useful leaf of DSH 0.1.6's
 * `TokenMeter`: callers may pass `meter.estimateMessage.bind(meter)`, or project
 * `TokenMeasurement.nodes` directly.  This module does not mount Cordis, an
 * agent loop, or a provider.  The fallback uses DSH's documented 4 chars/token
 * plus structural overhead heuristic.
 */
export interface PressureMessage {
  readonly id: string;
  readonly role: string;
  readonly content?: unknown;
  /** Provider accounting attached to a completed assistant request. */
  readonly usage?: { readonly input?: number; readonly output?: number; readonly cacheRead?: number; readonly cacheWrite?: number };
}

export interface TokenEstimateAdapter<M extends PressureMessage = PressureMessage> {
  readonly name: string;
  estimateMessage(message: M): number;
}

export interface MessageTokenBreakdown {
  readonly index: number;
  readonly id: string;
  readonly role: string;
  readonly estimatedTokens: number;
  /** Estimated request prefix ending immediately before this assistant output. */
  readonly replayRequestTokens?: number;
  readonly reportedRequestTokens?: number;
}

export interface SessionTokenBreakdown {
  readonly adapter: string;
  readonly messages: readonly MessageTokenBreakdown[];
  readonly surfaceTokens: number;
  /** Sum of all request prefixes. This exposes replay cost instead of counting only the final surface. */
  readonly replayTokens: number;
  readonly requestCount: number;
  readonly reportedRequestTokens: number;
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function json(value: unknown): string {
  try { return JSON.stringify(value) ?? ""; } catch { return String(value); }
}

export const heuristicTokenAdapter: TokenEstimateAdapter = Object.freeze({
  name: "dsh-0.1.6-compatible-heuristic",
  estimateMessage(message: PressureMessage): number {
    const body = typeof message.content === "string" ? message.content : json(message.content);
    return 4 + Math.ceil(body.length / 4);
  },
});

/** Deterministic and input-immutable replay accounting. */
export function measureSessionTokens<M extends PressureMessage>(
  messages: readonly M[], adapter: TokenEstimateAdapter<M> = heuristicTokenAdapter,
): SessionTokenBreakdown {
  let prefix = 0, replayTokens = 0, requests = 0, reported = 0;
  const breakdown: MessageTokenBreakdown[] = [];
  messages.forEach((message, index) => {
    const estimate = adapter.estimateMessage(message);
    if (!Number.isSafeInteger(estimate) || estimate < 0) throw new TypeError(`invalid token estimate for message ${message.id}`);
    const isResponse = message.role === "assistant";
    let reportedRequest: number | undefined;
    if (isResponse) {
      requests++;
      replayTokens += prefix;
      // Providers vary: some report uncached input separately, some include it.
      // Preserve their number; never synthesize it from cache eligibility.
      reportedRequest = finiteNonnegative(message.usage?.input);
      if (reportedRequest !== undefined) reported += reportedRequest;
    }
    breakdown.push(Object.freeze({ index, id: message.id, role: message.role, estimatedTokens: estimate,
      ...(isResponse ? { replayRequestTokens: prefix } : {}),
      ...(reportedRequest === undefined ? {} : { reportedRequestTokens: reportedRequest }) }));
    prefix += estimate;
  });
  return Object.freeze({ adapter: adapter.name, messages: Object.freeze(breakdown), surfaceTokens: prefix,
    replayTokens, requestCount: requests, reportedRequestTokens: reported });
}

export type PressureLevel = "ok" | "compact" | "overflow";
export function classifyTokenPressure(totalTokens: number, contextWindow: number, thresholdRatio = 0.8): PressureLevel {
  if (![totalTokens, contextWindow, thresholdRatio].every(Number.isFinite) || totalTokens < 0 || contextWindow <= 0 || thresholdRatio <= 0 || thresholdRatio > 1) {
    throw new TypeError("invalid pressure inputs");
  }
  if (totalTokens > contextWindow) return "overflow";
  return totalTokens >= Math.floor(contextWindow * thresholdRatio) ? "compact" : "ok";
}
