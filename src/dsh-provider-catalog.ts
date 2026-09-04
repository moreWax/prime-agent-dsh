import type { Api } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const PROVIDER_ID = "dsh";
export const PROVIDER_API = "dsh-exec" as Api;
export const PROVIDER_BASE_URL = "dsh-exec://local";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

// DSH's configured DeepSeek models (deepseek-v4-pro / deepseek-v4-flash)
// both expose a 1M-token context window. maxTokens stays conservative since
// DSH (rc) exposes no per-model max-output metadata.
const CONTEXT_WINDOW = 1_000_000;
const MAX_TOKENS = 32_000;

/**
 * Synthetic fallback entry: selecting it means "run this turn on the DSH
 * harness" with whatever model DSH's own settings configure.
 */
const FALLBACK_MODEL: ProviderModelConfig = {
  id: "dsh-harness",
  name: "DeepSeek Harness (dsh)",
  reasoning: true,
  input: ["text"],
  cost: { ...ZERO_COST },
  contextWindow: CONTEXT_WINDOW,
  maxTokens: MAX_TOKENS,
};

/**
 * Keep one stable Prime model identity. The selected model is an execution
 * harness, not a snapshot of DSH settings. DSH resolves its provider, model,
 * and reasoning effort together when a new pooled agent is created.
 */
export function buildModels(): ProviderModelConfig[] {
  return [{ ...FALLBACK_MODEL, cost: { ...ZERO_COST }, input: ["text"] }];
}
