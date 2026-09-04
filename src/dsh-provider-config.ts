import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { load as loadYaml } from "js-yaml";
import type { ConfigFile, DshModelSelection, McpServerConfig, ResolvedConfig } from "./dsh-provider-types.js";

const DEFAULT_DSH_BIN = "dsh";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30min, matches dsh's own turn budget
const DEFAULT_MODE = "pool";
const DEFAULT_POOL_MAX = 8;
const DEFAULT_POOL_IDLE_TTL_MS = 15 * 60 * 1000; // 15min
const CONFIG_PATH = join(process.env.PRIME_AGENT_HOME ?? join(homedir(), ".prime", "agent"), "dsh.json");
const DSH_SETTINGS_PATH = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "settings.yaml");

export function loadConfig(): ResolvedConfig {
  const fromFile = readConfigFile(CONFIG_PATH);
  const envBin = process.env.PI_DSH_BIN?.trim();
  const envTimeout = coercePositiveInt(process.env.PI_DSH_TIMEOUT_MS);
  const envMode = coerceMode(process.env.PI_DSH_MODE);
  const envPoolMax = coercePositiveInt(process.env.PI_DSH_POOL_MAX);
  const envPoolIdle = coercePositiveInt(process.env.PI_DSH_POOL_IDLE_TTL_MS);
  const envFullAccess = coerceFullAccess(process.env.PI_DSH_FULL_ACCESS);
  const envTransparent = coerceBoolean(process.env.PI_DSH_TRANSPARENT);

  return {
    dshBin: envBin || fromFile.parsed.dshBin?.trim() || DEFAULT_DSH_BIN,
    timeoutMs: envTimeout ?? fromFile.parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    mode: envMode ?? fromFile.parsed.mode ?? DEFAULT_MODE,
    poolMax: envPoolMax ?? fromFile.parsed.poolMax ?? DEFAULT_POOL_MAX,
    poolIdleTtlMs: envPoolIdle ?? fromFile.parsed.poolIdleTtlMs ?? DEFAULT_POOL_IDLE_TTL_MS,
    fullAccess: envFullAccess ?? fromFile.parsed.fullAccess ?? false,
    transparent: envTransparent ?? fromFile.parsed.transparent ?? true,
    mcpServers: fromFile.parsed.mcpServers ?? [],
    persistentTerminal: fromFile.parsed.persistentTerminal ?? false,
    model: readDshDefaultModel(),
    loadedFrom: fromFile.exists ? CONFIG_PATH : undefined,
  };
}

/**
 * Read DSH's own configured default model (`agent-default-model` in
 * `~/.dsh/settings.yaml`, honoring $DSH_HOME). This is what the Pi catalog
 * shows and what pooled agents run. Undefined when unreadable — callers then
 * fall back to the synthetic entry / DSH's live selection.
 */
function readDshDefaultModel(): DshModelSelection | undefined {
  try {
    if (!existsSync(DSH_SETTINGS_PATH)) return undefined;
    const parsed: unknown = loadYaml(readFileSync(DSH_SETTINGS_PATH, "utf8"));
    const entry = asRecord(asRecord(parsed)?.["agent-default-model"]);
    const provider = typeof entry?.provider === "string" ? entry.provider.trim() : "";
    const model = typeof entry?.model === "string" ? entry.model.trim() : "";
    const reasoningEffort = typeof entry?.reasoningEffort === "string" ? entry.reasoningEffort.trim() : "";
    if (!provider || !model) return undefined;
    return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
  } catch {
    console.warn(`[pi-dsh] Failed to read ${DSH_SETTINGS_PATH}. Catalog falls back to the synthetic entry.`);
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Only exact documented values opt in/out; malformed values cannot grant access. */
export function coerceBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === "1") return true;
  if (raw === "0") return false;
  return undefined;
}

export function coerceFullAccess(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === "1") return true;
  if (raw === "0") return false;
  return undefined;
}

function coercePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function coerceMode(raw: string | undefined): "pool" | "oneshot" | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "pool" || trimmed === "oneshot" ? trimmed : undefined;
}

function readConfigFile(path: string): { exists: boolean; parsed: ConfigFile } {
  if (!existsSync(path)) return { exists: false, parsed: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return { exists: true, parsed: coerceConfigFile(parsed, path) };
  } catch (error) {
    console.warn(`[pi-dsh] Failed to read ${path}: ${(error as Error).message}. Using defaults.`);
    return { exists: true, parsed: {} };
  }
}

export function coerceConfigFile(value: unknown, path: string): ConfigFile {
  if (!isPlainObject(value)) {
    console.warn(`[pi-dsh] ${path} is not a JSON object. Ignoring contents.`);
    return {};
  }
  const out: ConfigFile = {};
  if (typeof value.dshBin === "string") out.dshBin = value.dshBin;
  if (typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0) {
    out.timeoutMs = value.timeoutMs;
  }
  if (value.mode === "pool" || value.mode === "oneshot") out.mode = value.mode;
  if (typeof value.poolMax === "number" && Number.isFinite(value.poolMax) && value.poolMax > 0) {
    out.poolMax = value.poolMax;
  }
  if (typeof value.fullAccess === "boolean") out.fullAccess = value.fullAccess;
  if (typeof value.transparent === "boolean") out.transparent = value.transparent;
  if (typeof value.poolIdleTtlMs === "number" && Number.isFinite(value.poolIdleTtlMs) && value.poolIdleTtlMs > 0) {
    out.poolIdleTtlMs = value.poolIdleTtlMs;
  }
  if (typeof value.persistentTerminal === "boolean") out.persistentTerminal = value.persistentTerminal;
  if (Array.isArray(value.mcpServers)) {
    const names = new Set<string>();
    out.mcpServers = value.mcpServers.flatMap((entry, index) => {
      const parsed = coerceMcpServer(entry);
      if (!parsed || names.has(parsed.serverName)) {
        console.warn(`[pi-dsh] ${path}.mcpServers[${index}] is invalid or duplicates a serverName. Ignoring entry.`);
        return [];
      }
      names.add(parsed.serverName);
      return [parsed];
    });
  }
  return out;
}

function coerceMcpServer(value: unknown): McpServerConfig | undefined {
  if (!isPlainObject(value) || typeof value.serverName !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(value.serverName)) return undefined;
  const toolCallTimeoutMs = typeof value.toolCallTimeoutMs === "number" && Number.isSafeInteger(value.toolCallTimeoutMs) && value.toolCallTimeoutMs > 0 ? value.toolCallTimeoutMs : undefined;
  if (value.transport === "stdio" && typeof value.command === "string" && isAbsolute(value.command)) {
    if (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every((item) => typeof item === "string"))) return undefined;
    if (value.env !== undefined && (!isPlainObject(value.env) || !Object.values(value.env).every((item) => typeof item === "string"))) return undefined;
    if (value.cwd !== undefined && (typeof value.cwd !== "string" || !isAbsolute(value.cwd))) return undefined;
    return { transport: "stdio", serverName: value.serverName, command: value.command,
      ...(value.args ? { args: value.args } : {}), ...(value.env ? { env: value.env as Record<string, string> } : {}),
      ...(value.cwd ? { cwd: value.cwd } : {}), ...(toolCallTimeoutMs ? { toolCallTimeoutMs } : {}) };
  }
  if (value.transport === "streamable-http" && typeof value.url === "string") {
    try { const url = new URL(value.url); if (url.protocol !== "http:" && url.protocol !== "https:") return undefined; } catch { return undefined; }
    if (value.headers !== undefined && (!isPlainObject(value.headers) || !Object.values(value.headers).every((item) => typeof item === "string"))) return undefined;
    return { transport: "streamable-http", serverName: value.serverName, url: value.url,
      ...(value.headers ? { headers: value.headers as Record<string, string> } : {}), ...(toolCallTimeoutMs ? { toolCallTimeoutMs } : {}) };
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const CONFIG_PATH_FOR_DIAGNOSTICS = CONFIG_PATH;
