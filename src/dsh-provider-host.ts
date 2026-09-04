// src/dsh-host.ts — the ONLY module that imports @deepseek-ai/*.
//
// Single chokepoint over the unstable in-process DSH surface (0.1.2-alpha.5,
// SESSION_FORMAT_VERSION 0, "no compatibility is implied"). Any dsh upgrade
// must re-run the plan-002 Phase 1–2 gates before bumping these pins.
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { boot, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { createUserMessage, ReasoningEffortId, type ContentBlock } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type { ApprovalOutcome, ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import { apply as mountAskUserTool } from "@deepseek-ai/dsh-tool-ask-user";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
import * as PersistentBash from "@deepseek-ai/dsh-tool-bash-persistent";
import { createPrivateRootConfig } from "./dsh-provider-security.js";
import { BusyLruPool, type PoolEntry } from "./dsh-agent-pool.js";
import type { TranscriptMessage } from "./context-seed.js";
import type { PreparedPrimeRoute } from "./model-route.js";
import type { McpServerConfig } from "./dsh-provider-types.js";
import { admitPrimeTurnContent, type PrimeTurnContent } from "./dsh-image-attachments.js";

const require = createRequire(import.meta.url);

const SWEEP_INTERVAL_MS = 60 * 1000;

/** Safety policy applied on top of the stock DSH base profile. */
export const EMBEDDED_OPERATION_LIMITS = Object.freeze({
  subagentMaxDepth: 2,
  workflowMaxConcurrentAgents: 4,
  workflowMaxTotalAgents: 16,
  workflowMaxItemsPerCall: 64,
  workflowSyncTimeoutMs: 2_000,
  workflowDisposeGraceMs: 2_000,
  jobWaitTimeoutMs: 5_000,
  jobMaxWaitTimeoutMs: 30_000,
});

// ---------------------------------------------------------------------------
// Shapes handed to providers.ts (kept free of @deepseek-ai types)
// ---------------------------------------------------------------------------

/** One raw session/event entry, projected to the fields the translator needs. */
export interface SessionEventShape {
  type: string;
  seq: number;
  data: unknown;
}

export interface AgentEntry extends PoolEntry {
  key: string;
  cwd: string;
  /** Deterministic DSH session id (`pi-<sha256(key)>`), stable across processes. */
  sessionId: string;
  lastUsedAt: number;
  idleTtlMs: number;
  agent: Agent;
  handle: AgentHandle;
  fullAccess: boolean;
  route: PreparedPrimeRoute;
  /** Number of acquired or running turns. Busy entries cannot expire or be evicted. */
  activeUses: number;
  /** Serializes turns per agent (DSH runs one turn at a time). */
  turnLock: Promise<void>;
}

// ---------------------------------------------------------------------------
// Tree boot (lazy, module-level singleton)
// ---------------------------------------------------------------------------

interface TreeState {
  context?: Context;
  boot?: Promise<Context>;
}

const trees = new Map<string, TreeState>();
export type ApprovalAnswerer = (request: { toolName: string; reason?: string }) => Promise<boolean>;
export type UserQuestionAnswerer = (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>;
const approvalAnswerers = new WeakMap<Agent, ApprovalAnswerer>();
const userQuestionAnswerers = new WeakMap<Agent, UserQuestionAnswerer>();

async function canonicalCwd(cwd: string): Promise<string> {
  const absolute = resolve(cwd);
  try {
    return await realpath(absolute);
  } catch {
    // Let DSH report an invalid/nonexistent workspace. resolve() still gives us
    // a stable isolation key and never aliases it with another relative path.
    return absolute;
  }
}

async function bootTree(workspaceRoot: string, fullAccess: boolean, route: PreparedPrimeRoute): Promise<Context> {
  const basePatchPath = require.resolve("@deepseek-ai/dsh-base/cordis.patch.yml");
  const patches = loadOverlayPatches("prime-agent-dsh", basePatchPath);
  patches.push(...loadOverlayPatches("prime-agent-dsh-route", route.modelPatch));
  patches.push({ id: "hmr", disabled: true });
  // The stock base profile intentionally supports large standalone workloads.
  // Embedded turns need tighter, deterministic bounds so a single model call
  // cannot create an unbounded child fan-out or wait on a job for minutes.
  patches.push({ id: "tool-subagent", config: {
    provider: "spawn", toolName: "subagent", backgroundMode: "continuable",
    maxDepth: EMBEDDED_OPERATION_LIMITS.subagentMaxDepth,
  } });
  patches.push({ id: "workflow-worker-thread", config: {
    provider: "spawn",
    maxConcurrentAgents: EMBEDDED_OPERATION_LIMITS.workflowMaxConcurrentAgents,
    maxTotalAgents: EMBEDDED_OPERATION_LIMITS.workflowMaxTotalAgents,
    maxItemsPerCall: EMBEDDED_OPERATION_LIMITS.workflowMaxItemsPerCall,
    syncTimeoutMs: EMBEDDED_OPERATION_LIMITS.workflowSyncTimeoutMs,
    disposeGraceMs: EMBEDDED_OPERATION_LIMITS.workflowDisposeGraceMs,
  } });
  patches.push({ id: "tool-jobs", config: {
    waitTimeoutMs: EMBEDDED_OPERATION_LIMITS.jobWaitTimeoutMs,
    maxWaitTimeoutMs: EMBEDDED_OPERATION_LIMITS.jobMaxWaitTimeoutMs,
    completionDelivery: "quiet", maxConsecutiveWakes: 1,
  } });
  patches.push({
    id: "sandbox-policy",
    config: { mode: fullAccess ? "danger-full-access" : "workspace-write", workspaceRoot },
  });
  patches.push({ id: "approval", config: { policy: fullAccess ? "never" : "ask" } });
  // Alpha.5 persistent-terminal services are inert until its model-facing tool
  // is explicitly installed in an Agent scope by operator configuration.
  patches.push({ insert: [
    { id: "prime-dsh-terminal", name: "@deepseek-ai/dsh-terminal" },
    { id: "prime-dsh-terminal-bash", name: "@deepseek-ai/dsh-terminal-bash", disabled: process.platform === "win32", config: { timeoutMs: 300000 } },
  ] });

  // llm-pi-ai resolves apiKeyEnv at request time. The value is an unprivileged,
  // loopback-only capability and is never included in a patch or session log.
  for (const [name, value] of Object.entries(route.env)) process.env[name] = value;
  const root = createPrivateRootConfig();
  let ctx: Context;
  try {
    ctx = await boot("prime-agent-dsh", root.path, patches, (bootCtx) => {
      bootCtx.on("approval/request", async (request: ApprovalRequest, next): Promise<ApprovalOutcome> => {
        const answer = approvalAnswerers.get(request.agent);
        if (!answer) return next();
        return (await answer({ toolName: request.toolName, reason: request.reason }))
          ? "allowed-once"
          : "rejected";
      });
      bootCtx.on("user-questions/request", async (request: AskUserQuestionRequest, next): Promise<AskUserQuestionAnswer> => {
        // The event itself is Agent-scoped by DSH. The identity lookup also
        // prevents one pooled agent from consuming another agent's answerer.
        const answer = request.agent && userQuestionAnswerers.get(request.agent);
        return answer ? answer(request) : next();
      });
    }, import.meta.url);
  } finally {
    root.cleanup();
  }
  const agents = ctx.get("agents");
  const defaultModel = ctx.get("agentDefaultModel");
  const persistence = ctx.get("sessionPersistence");
  if (!agents || !defaultModel || !persistence) {
    throw new Error("[pi-dsh] booted dsh tree is missing agents/agentDefaultModel/sessionPersistence");
  }
  return ctx;
}

function getTree(workspaceRoot: string, fullAccess: boolean, route: PreparedPrimeRoute): Promise<Context> {
  const treeKey = `${fullAccess ? "full" : "safe"}\0${workspaceRoot}\0${route.fingerprint}`;
  let state = trees.get(treeKey);
  if (!state) {
    state = {};
    trees.set(treeKey, state);
  }
  if (state.context) return Promise.resolve(state.context);
  if (!state.boot) {
    state.boot = bootTree(workspaceRoot, fullAccess, route).catch((error: unknown) => {
      state.boot = undefined;
      throw error;
    });
  }
  return state.boot.then((ctx) => {
    state.context = ctx;
    return ctx;
  });
}

// ---------------------------------------------------------------------------
// Pool (keyed by Pi conversation id), LRU + idle-TTL sweeper
// ---------------------------------------------------------------------------

async function disposeAgent(entry: AgentEntry): Promise<void> {
  try {
    const ctx = await getTree(entry.cwd, entry.fullAccess, entry.route);
    await ctx.get("sessions")?.flush(entry.agent.session);
  } catch {
    // flush is best-effort
  }
  try {
    await entry.handle.dispose();
  } catch {
    // dispose is best-effort
  }
}

const pool = new BusyLruPool<AgentEntry>(disposeAgent);
let sweeper: ReturnType<typeof setInterval> | undefined;

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => void pool.sweepExpired(), SWEEP_INTERVAL_MS);
  sweeper.unref?.();
  process.once("exit", () => {
    for (const entry of pool.values()) {
      try { void entry.handle.dispose(); } catch { /* best-effort */ }
    }
  });
}

/** Deterministic, process-stable DSH session id derived from an isolated pool key. */
function deterministicSessionId(key: string): string {
  return "pi-" + createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/**
 * Stable DSH session id for one Prime conversation. Deliberately derived from
 * the conversation identity ALONE — never from cwd, model route, sandbox mode,
 * or MCP capability — so that resuming the same Prime session (possibly in a
 * different cwd or with a different model) reattaches to the SAME DSH
 * conversation instead of forking an empty one. Pool LRU bookkeeping still
 * uses the full isolated key; only the persisted session id is conversation-
 * scoped.
 */
export function conversationSessionId(sessionKey: string): string {
  return deterministicSessionId(`pi-conversation\0${sessionKey}`);
}

export interface AgentPoolOptions {
  cwd: string;
  route: PreparedPrimeRoute;
  poolMax: number;
  idleTtlMs: number;
  fullAccess: boolean;
  approvalAnswerer?: ApprovalAnswerer;
  userQuestionAnswerer?: UserQuestionAnswerer;
  mcpServers: McpServerConfig[];
  persistentTerminal: boolean;
  /** Stage 3: rebuild the DSH log from Prime's transcript when nothing persisted. */
  resumeSeed?: boolean;
  seed?: () => Promise<TranscriptMessage[]> | TranscriptMessage[];
  /** Fired after a Stage 3 rebuild so the host can tell the operator. */
  onRestored?: (info: { dshSessionId: string; seededTurns: number }) => void;
}

export function agentPoolKey(cwd: string, sessionKey: string, fullAccess: boolean, routeFingerprint: string): string {
  return `${fullAccess ? "full" : "safe"}\0${cwd}\0${routeFingerprint}\0${sessionKey}`;
}

export async function getOrCreateAgent(key: string, opts: AgentPoolOptions): Promise<AgentEntry> {
  ensureSweeper();
  const cwd = await canonicalCwd(opts.cwd);
  const capabilityFingerprint = createHash("sha256").update(JSON.stringify({
    mcpServers: opts.mcpServers, persistentTerminal: opts.persistentTerminal,
  })).digest("hex");
  const isolatedKey = `${agentPoolKey(cwd, key, opts.fullAccess, opts.route.fingerprint)}\0${capabilityFingerprint}`;
  // The persisted conversation id is stable across cwd/model/mode changes.
  const sid = conversationSessionId(key);
  const entry = await pool.acquire(isolatedKey, opts.poolMax, async () => {
    const ctx = await getTree(cwd, opts.fullAccess, opts.route);
    const agents = ctx.get("agents");
    const defaultModel = ctx.get("agentDefaultModel");
    const persistence = ctx.get("sessionPersistence");
    if (!agents || !defaultModel || !persistence) {
      throw new Error("[pi-dsh] dsh tree is missing agents/agentDefaultModel/sessionPersistence");
    }
    const target = { provider: opts.route.provider, model: opts.route.model,
      ...(opts.route.reasoningEffort ? { reasoningEffort: ReasoningEffortId(opts.route.reasoningEffort) } : {}) };
    const persisted = await persistence.list()
      .then((headers) => headers.some((header) => header.id === sid))
      .catch(() => false);
    const makeOptions = () => ({
      agentOptions: target,
      setup: async (agentCtx: Context): Promise<void> => {
        installModelSelection(agentCtx, { current: target, assembled: undefined });
        // Only trusted operator config reaches this composition point. There is
        // deliberately no model-facing MCP server-management capability.
        for (const server of opts.mcpServers) {
          const config = server.transport === "stdio"
            ? McpClient.Config({ transport: "stdio", serverName: server.serverName, command: server.command,
                args: server.args ?? [], env: server.env ?? {}, cwd: server.cwd ?? cwd,
                toolCallTimeoutMs: server.toolCallTimeoutMs ?? 60000, failOnStartupError: server.optional !== true })
            : McpClient.Config({ transport: "streamable-http", serverName: server.serverName, url: server.url,
                headers: server.headers ?? {}, toolCallTimeoutMs: server.toolCallTimeoutMs ?? 60000, failOnStartupError: server.optional !== true });
          await agentCtx.plugin(McpClient, config);
        }
        if (opts.persistentTerminal && process.platform !== "win32") {
          agentCtx.plugin(PersistentBash, PersistentBash.Config({ timeoutMs: 300000 }));
        }
      },
    });
    const handle = persisted
      ? await agents.resume({ resumeSessionId: SessionId(sid), ...makeOptions() })
      : await agents.create({ sessionId: SessionId(sid), meta: { cwd }, ...makeOptions() });
    if (!persisted && opts.resumeSeed && opts.seed) {
      // Stage 3 (best-effort): rebuild from Prime's canonical transcript so a
      // resumed conversation whose DSH session was evicted continues with its
      // history instead of starting blank. Never fatal.
      try {
        const transcript = await opts.seed();
        if (transcript.length > 0) {
          const { seedSession } = await import("./context-seed.js");
          const seeded = seedSession(handle.agent.session as never, transcript);
          if (seeded > 0) opts.onRestored?.({ dshSessionId: sid, seededTurns: seeded });
        }
      } catch {
        // fall back to a blank start
      }
    }
    await handle.agent.whenIdle();
    // Standard DSH presets already mount this. Custom/minimal presets may not;
    // mount it in the agent realm only when the registry lacks it.
    // Cordis' dynamic service lookup is intentionally untyped at this boundary.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const tools = handle.agent.ctx.get("tools");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    if (!tools?.get("ask_user_question", handle.agent)) mountAskUserTool(handle.agent.ctx);
    return {
      key: isolatedKey, cwd, sessionId: sid, lastUsedAt: Date.now(),
      idleTtlMs: opts.idleTtlMs, activeUses: 0, fullAccess: opts.fullAccess,
      agent: handle.agent, handle, route: opts.route, turnLock: Promise.resolve(),
    };
  });
  if (opts.approvalAnswerer) approvalAnswerers.set(entry.agent, opts.approvalAnswerer);
  if (opts.userQuestionAnswerer) userQuestionAnswerers.set(entry.agent, opts.userQuestionAnswerer);
  return entry;
}

/** Flush the session log to persistence and dispose the agent handle. */
export async function destroyAgent(entry: AgentEntry): Promise<void> {
  await pool.remove(entry);
}

/**
 * Drive one turn: admit ordered multimodal content, subscribe the event firehose,
 * wait for quiescence, and flush the session to persistence (so a later
 * cross-process resume sees the whole log). `onEvent` fires synchronously per
 * session event. On `signal` abort the active turn is cancelled WITHOUT
 * destroying the entry (droid rule: abort preserves the session). Turns on one
 * entry are serialized.
 */
export async function runTurn(
  entry: AgentEntry,
  content: readonly PrimeTurnContent[],
  signal: AbortSignal | undefined,
  onEvent: (event: SessionEventShape) => void,
): Promise<void> {
  const { agent } = entry;

  const run = entry.turnLock.then(async () => {
    await agent.whenIdle();

    let unsub: (() => void) | undefined;
    const abortHandler = (): void => {
      try {
        agent.cancel({ kind: "user" });
      } catch {
        // cancellation is best-effort; whenIdle will still settle
      }
    };

    try {
      unsub = agent.ctx.on("session/event", (session, event) => {
        if (session?.id !== agent.session.id) return;
        pool.touch(entry);
        onEvent({ type: event.type, seq: event.seq, data: event.data });
      });
      if (signal) {
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }
      const tree = await getTree(entry.cwd, entry.fullAccess, entry.route);
      const attachments = tree.get("attachments");
      if (!attachments) throw new Error("[pi-dsh] booted tree is missing attachment admission");
      const blocks: ContentBlock[] = await admitPrimeTurnContent(attachments, content);
      agent.followup(
        createUserMessage({
          content: blocks,
          source: { kind: "user" },
        }),
      );
      await agent.whenIdle();
    } finally {
      unsub?.();
      if (signal) signal.removeEventListener("abort", abortHandler);
      // Persist this turn so cross-process resume keeps the full history.
      try {
        const ctx = await getTree(entry.cwd, entry.fullAccess, entry.route);
        await ctx.get("sessions")?.flush(agent.session);
      } catch {
        // flush is best-effort
      }
    }
  });

  // Serialize turns per entry and never let a failed turn poison the chain.
  entry.turnLock = run.then(
    () => undefined,
    () => undefined,
  );
  try {
    await run;
  } finally {
    pool.release(entry);
  }
}
