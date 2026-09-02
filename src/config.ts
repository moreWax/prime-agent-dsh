import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export interface BridgeConfig {
  profile: string;
  patches: string[];
  dshHome: string;
  dshBin?: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
  initializeTimeoutMs: number;
  requestTimeoutMs?: number;
  childEnv?: NodeJS.ProcessEnv;
}

function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function absolutePaths(value: string | undefined, cwd: string): string[] {
  if (!value?.trim()) return [];
  return value.split(/[;,]/).map((part) => part.trim()).filter(Boolean).map((part) => resolve(cwd, part));
}

export function loadConfig(cwd: string, flags: { dshBin?: string; dshHome?: string } = {}): BridgeConfig {
  const dshHomeInput = flags.dshHome || process.env.PRIME_DSH_HOME || resolve(homedir(), ".prime", "agent", "deepseek-harness");
  const dshHome = isAbsolute(dshHomeInput) ? dshHomeInput : resolve(cwd, dshHomeInput);
  const dshBinInput = flags.dshBin || process.env.PRIME_DSH_BIN;
  return {
    profile: process.env.PRIME_DSH_PROFILE || "acp",
    patches: absolutePaths(process.env.PRIME_DSH_PATCHES, cwd),
    dshHome,
    ...(dshBinInput ? { dshBin: isAbsolute(dshBinInput) ? dshBinInput : resolve(cwd, dshBinInput) } : {}),
    provider: process.env.PRIME_DSH_PROVIDER || "deepseek-official",
    model: process.env.PRIME_DSH_MODEL || "deepseek-v4-flash",
    ...(process.env.PRIME_DSH_REASONING_EFFORT ? { reasoningEffort: process.env.PRIME_DSH_REASONING_EFFORT } : {}),
    ...(positiveInteger(process.env.PRIME_DSH_MAX_TOKENS, "PRIME_DSH_MAX_TOKENS") !== undefined
      ? { maxTokens: positiveInteger(process.env.PRIME_DSH_MAX_TOKENS, "PRIME_DSH_MAX_TOKENS") }
      : {}),
    initializeTimeoutMs: positiveInteger(process.env.PRIME_DSH_INITIALIZE_TIMEOUT_MS, "PRIME_DSH_INITIALIZE_TIMEOUT_MS") ?? 15_000,
    ...(positiveInteger(process.env.PRIME_DSH_REQUEST_TIMEOUT_MS, "PRIME_DSH_REQUEST_TIMEOUT_MS") !== undefined
      ? { requestTimeoutMs: positiveInteger(process.env.PRIME_DSH_REQUEST_TIMEOUT_MS, "PRIME_DSH_REQUEST_TIMEOUT_MS") }
      : {}),
  };
}

export async function ensureDshHome(config: BridgeConfig): Promise<void> {
  await mkdir(config.dshHome, { recursive: true, mode: 0o700 });
}

export function configKey(config: BridgeConfig, cwd: string): string {
  return JSON.stringify({ cwd: resolve(cwd), profile: config.profile, patches: config.patches, dshHome: config.dshHome,
    dshBin: config.dshBin, provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort,
    maxTokens: config.maxTokens });
}
