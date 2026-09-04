import type { Api } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { DshModelSelection } from "./dsh-provider-types.js";

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
 * Build the Pi catalog. When DSH's configured default model was read
 * successfully (`~/.dsh/settings.yaml` → `agent-default-model`), the catalog
 * shows THAT real model (e.g. `dsh/deepseek-v4-pro`) so the picker matches
 * what the harness actually runs; otherwise it falls back to the synthetic
 * `dsh-harness` entry. DSH owns model selection — pi-dsh never invents models.
 */
export function buildModels(configured: DshModelSelection | undefined): ProviderModelConfig[] {
  if (configured?.provider && configured.model) {
    return [
      {
        id: configured.model,
        name: `${configured.model} (DSH · ${configured.provider})`,
        reasoning: true,
        input: ["text"],
        cost: { ...ZERO_COST },
        contextWindow: CONTEXT_WINDOW,
        maxTokens: MAX_TOKENS,
      },
    ];
  }
  return [FALLBACK_MODEL];
}
