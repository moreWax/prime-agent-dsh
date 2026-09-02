import { DeepSeekHarness, type HarnessNotification, type RunResult } from "@deepseek-ai/dsh-sdk-client";
import type { BridgeConfig } from "./config.js";
import { configKey, ensureDshHome } from "./config.js";

export interface RunOptions {
  cwd: string;
  sessionId: string;
  signal?: AbortSignal;
  onNotification?: (notification: HarnessNotification) => void;
}

interface RuntimeEntry {
  harness: DeepSeekHarness;
  key: string;
  queue: Promise<unknown>;
  startedAt: number;
}

export class RuntimeManager {
  private entries = new Map<string, RuntimeEntry>();
  private closed = false;

  async run(prompt: string, config: BridgeConfig, options: RunOptions): Promise<RunResult> {
    if (this.closed) throw new Error("DeepSeek Harness bridge is closed");
    if (!prompt.trim()) throw new Error("A non-empty prompt is required");
    if (options.signal?.aborted) throw abortError();
    await ensureDshHome(config);
    const key = configKey(config, options.cwd);
    let entry = this.entries.get(key);
    if (!entry) {
      const harness = new DeepSeekHarness({
        profile: config.profile,
        patches: config.patches,
        dshHome: config.dshHome,
        processCwd: options.cwd,
        cwd: options.cwd,
        provider: config.provider,
        model: config.model,
        ...(config.dshBin ? { dshBin: config.dshBin } : {}),
        ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort as never } : {}),
        ...(config.maxTokens ? { maxTokens: config.maxTokens } : {}),
        initializeTimeoutMs: config.initializeTimeoutMs,
        ...(config.requestTimeoutMs ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
      });
      entry = { harness, key, queue: Promise.resolve(), startedAt: Date.now() };
      this.entries.set(key, entry);
    }
    const operation = entry.queue.then(() => this.runAbortAware(entry!, prompt, options));
    entry.queue = operation.catch(() => undefined);
    return operation;
  }

  private async runAbortAware(entry: RuntimeEntry, prompt: string, options: RunOptions): Promise<RunResult> {
    if (options.signal?.aborted) throw abortError();
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      // DSH SDK currently has no per-turn cancel. Closing the owned runtime is the only honest cancellation.
      void entry.harness.close().finally(() => this.entries.delete(entry.key));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await entry.harness.run(prompt, {
        sessionId: options.sessionId,
        onNotification: options.onNotification,
      });
      if (aborted) throw abortError();
      return result;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  status(): Array<{ key: string; startedAt: number }> {
    return [...this.entries.values()].map(({ key, startedAt }) => ({ key, startedAt }));
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map((entry) => entry.harness.close()));
  }
}

function abortError(): Error {
  const error = new Error("DeepSeek Harness run aborted; its runtime was closed because the current DSH SDK has no per-turn cancel method");
  error.name = "AbortError";
  return error;
}
