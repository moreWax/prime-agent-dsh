import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { DshAcpClient, type AcpContentBlock, type DshPromptResult } from "./acp-client.js";
import type { BridgeConfig } from "./config.js";
import { configKey, ensureDshHome } from "./config.js";

const require = createRequire(import.meta.url);

export interface RunOptions {
  cwd: string;
  sessionId?: string;
  signal?: AbortSignal;
  promptBlocks?: AcpContentBlock[];
  onUpdate?: (notification: SessionNotification) => void | Promise<void>;
  onPermission?: (title: string, options: Array<{ id: string; label: string; allow: boolean }>) => Promise<string | undefined>;
}

export interface BridgeRunResult extends DshPromptResult { resumed: boolean; }
interface RuntimeEntry { client: DshAcpClient; key: string; queue: Promise<unknown>; startedAt: number; activeSessions: Set<string>; }

function bundledDshBin(): string {
  const manifest = require.resolve("@deepseek-ai/dsh/package.json");
  return resolve(dirname(manifest), "lib", "bin.js");
}

export class RuntimeManager {
  private entries = new Map<string, RuntimeEntry>();
  private closed = false;

  async run(prompt: string, config: BridgeConfig, options: RunOptions): Promise<BridgeRunResult> {
    if (this.closed) throw new Error("DeepSeek Harness bridge is closed");
    if (!prompt.trim() && !options.promptBlocks?.length) throw new Error("A non-empty prompt is required");
    if (options.signal?.aborted) throw abortError();
    await ensureDshHome(config);
    const key = configKey(config, options.cwd);
    let entry = this.entries.get(key);
    if (!entry) {
      const client = new DshAcpClient({
        cwd: options.cwd,
        dshHome: config.dshHome,
        dshBin: config.dshBin ?? bundledDshBin(),
        patches: config.patches,
        initializeTimeoutMs: config.initializeTimeoutMs,
        env: config.childEnv,
      });
      entry = { client, key, queue: Promise.resolve(), startedAt: Date.now(), activeSessions: new Set() };
      this.entries.set(key, entry);
    }
    // ACP permits one prompt at a time per session. Serialize per runtime as a
    // conservative boundary while the bridge maintains one active Prime session.
    const operation = entry.queue.then(async () => {
      entry.client.setHandlers({
        onUpdate: options.onUpdate,
        permission: async (request) => {
          const choices = request.options.map((option) => ({ id: option.optionId, label: option.name,
            allow: option.kind === "allow_once" || option.kind === "allow_always" }));
          const title = request.toolCall.title ?? request.toolCall.kind ?? "DeepSeek Harness tool permission";
          const selected = await options.onPermission?.(title, choices);
          return selected ? { outcome: { outcome: "selected", optionId: selected } } : { outcome: { outcome: "cancelled" } };
        },
      });
      let sessionId = options.sessionId;
      let resumed = false;
      if (sessionId && !entry.activeSessions.has(sessionId)) {
        try {
          await entry.client.resumeSession(sessionId);
          resumed = true;
          entry.activeSessions.add(sessionId);
        } catch (error) {
          // v0.0.1 used caller-minted `prime-<hash>` SDK session ids. ACP
          // servers assign their own ids, so migrate those aliases once by
          // creating a fresh ACP session; never hide failure for real ACP ids.
          if (sessionId.startsWith("prime-")) sessionId = undefined;
          else throw error;
        }
      }
      if (!sessionId) {
        sessionId = await entry.client.newSession();
        entry.activeSessions.add(sessionId);
      }
      const input = options.promptBlocks?.length ? options.promptBlocks : prompt;
      return { ...(await entry.client.prompt(sessionId, input, options.signal)), resumed };
    });
    entry.queue = operation.catch(() => undefined);
    return operation;
  }

  async doctor(config: BridgeConfig, cwd: string): Promise<{ protocolVersion: number; sessionId: string }> {
    await ensureDshHome(config);
    const client = new DshAcpClient({ cwd, dshHome: config.dshHome, dshBin: config.dshBin ?? bundledDshBin(),
      patches: config.patches, initializeTimeoutMs: config.initializeTimeoutMs, env: config.childEnv });
    try {
      const initialized = await client.start();
      const sessionId = await client.newSession();
      await client.closeSession(sessionId);
      return { protocolVersion: initialized.protocolVersion, sessionId };
    } finally { await client.close(); }
  }

  status(): Array<{ key: string; startedAt: number }> {
    return [...this.entries.values()].map(({ key, startedAt }) => ({ key, startedAt }));
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map((entry) => entry.client.close()));
  }
}

function abortError(): Error { const error = new Error("DeepSeek Harness run aborted"); error.name = "AbortError"; return error; }
