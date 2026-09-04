// Pure turn-outcome mapping, shared by the pool translator and the path-B
// integration test (imported directly as a standalone .ts module by Node's
// type stripping — keep this file free of ANY imports).

export type TurnOutcome = "stop" | "aborted" | "error" | "incomplete";

/**
 * Map a DSH `turn/end` reason kind to the Pi termination outcome.
 *
 * - `completed` → normal stop
 * - `aborted`   → the turn was cancelled (Pi /stop); the pooled session survives
 * - `error`     → a real turn failure; the pooled session is destroyed
 * - anything else (`blocked` / `max-tokens` / `interrupted`) → deliver the
 *   partial text with a `dsh-incomplete-turn` diagnostic (plan 001 semantics)
 */
export function classifyTurnEnd(kind: unknown): TurnOutcome {
  if (kind === "completed") return "stop";
  if (kind === "aborted") return "aborted";
  if (kind === "error") return "error";
  return "incomplete";
}

/**
 * Step-aware content block keys. DSH restarts block indices on every agent
 * step, so a key that omits the step collapses every step's reasoning/text
 * into ONE block at the top (the segregated-look regression). The step must
 * be part of the key; two same-index blocks from different steps are two
 * distinct blocks.
 */
export function textBlockKey(step: number, index: number): string {
  return `text:${step}:${index}`;
}

export function thinkingBlockKey(step: number, index: number): string {
  return `think:${step}:${index}`;
}
