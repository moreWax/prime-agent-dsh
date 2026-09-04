export interface McpStdioServerConfig {
  transport: "stdio";
  serverName: string;
  /** Absolute executable path; no shell interpolation. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  toolCallTimeoutMs?: number;
  /** Best-effort mount: session still starts when the server is unreachable. */
  optional?: boolean;
}

export interface McpHttpServerConfig {
  transport: "streamable-http";
  serverName: string;
  /** Absolute HTTP(S) endpoint. */
  url: string;
  headers?: Record<string, string>;
  toolCallTimeoutMs?: number;
  /** Best-effort mount: session still starts when the server is unreachable. */
  optional?: boolean;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** User-overridable config file (`~/.prime/agent/dsh.json`). */
export interface ConfigFile {
  /** Path/command for the `dsh` CLI (default: `dsh` resolved from PATH). */
  dshBin?: string;
  /** Per-run timeout for a single DSH headless run, in ms (default 30min). */
  timeoutMs?: number;
  /** Turn driver: in-process session pool, or one-shot `dsh` subprocess. */
  mode?: "pool" | "oneshot";
  /** Max pooled sessions (LRU-evicted beyond this). Default 8. */
  poolMax?: number;
  /** Idle time before a pooled session is closed, in ms. Default 15min. */
  poolIdleTtlMs?: number;
  /** Explicitly disable the workspace sandbox and all approval prompts. */
  fullAccess?: boolean;
  /** Wrap normal Prime providers with DSH. Opt-in only; defaults to false so
   * installing this package changes nothing for other providers, tools, or
   * packages. */
  transparent?: boolean;
  /** Operator-declared servers mounted in each pooled Agent scope. */
  mcpServers?: McpServerConfig[];
  /** Enable an owner-scoped persistent shell tool. Default false. */
  persistentTerminal?: boolean;
}

/** DSH's configured default model (`~/.dsh/settings.yaml` → agent-default-model). */
export interface DshModelSelection {
  provider: string;
  model: string;
  /** Optional DSH reasoning effort coupled to this route. */
  reasoningEffort?: string;
}

export interface ResolvedConfig {
  dshBin: string;
  timeoutMs: number;
  mode: "pool" | "oneshot";
  poolMax: number;
  poolIdleTtlMs: number;
  /** True only after an explicit config or exact env opt-in. */
  fullAccess: boolean;
  /** Route ordinary Prime provider turns through DSH. */
  transparent: boolean;
  mcpServers: McpServerConfig[];
  persistentTerminal: boolean;
  /**
   * The real model DSH is configured to run, read from its settings.yaml at
   * load time. Undefined when unreadable — the catalog then falls back to the
   * synthetic `dsh-harness` entry and the pool follows DSH's live selection.
   */
  model?: DshModelSelection;
  /** Path the config was loaded from, or undefined when defaults were used. */
  loadedFrom?: string;
}
