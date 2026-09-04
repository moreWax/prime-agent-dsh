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
import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type { ApprovalOutcome, ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import { createPrivateRootConfig } from "./dsh-provider-security.js";
import { BusyLruPool, type PoolEntry } from "./dsh-agent-pool.js";

const require = createRequire(import.meta.url);

const SWEEP_INTERVAL_MS = 60 * 1000;

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
const approvalAnswerers = new WeakMap<Agent, ApprovalAnswerer>();

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

async function bootTree(workspaceRoot: string, fullAccess: boolean): Promise<Context> {
  const basePatchPath = require.resolve("@deepseek-ai/dsh-base/cordis.patch.yml");
  const patches = loadOverlayPatches("prime-agent-dsh", basePatchPath);
  patches.push({ id: "hmr", disabled: true });
  patches.push({
    id: "sandbox-policy",
    config: { mode: fullAccess ? "danger-full-access" : "workspace-write", workspaceRoot },
  });
  patches.push({ id: "approval", config: { policy: fullAccess ? "never" : "ask" } });

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

function getTree(workspaceRoot: string, fullAccess = false): Promise<Context> {
  const treeKey = `${fullAccess ? "full" : "safe"}\0${workspaceRoot}`;
  let state = trees.get(treeKey);
  if (!state) {
    state = {};
    trees.set(treeKey, state);
  }
  if (state.context) return Promise.resolve(state.context);
  if (!state.boot) {
    state.boot = bootTree(workspaceRoot, fullAccess).catch((error: unknown) => {
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
    const ctx = await getTree(entry.cwd, entry.fullAccess);
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

export interface AgentPoolOptions {
  cwd: string;
  model?: { provider: string; model: string; reasoningEffort?: string };
  poolMax: number;
  idleTtlMs: number;
  fullAccess: boolean;
  approvalAnswerer?: ApprovalAnswerer;
}

export async function getOrCreateAgent(key: string, opts: AgentPoolOptions): Promise<AgentEntry> {
  ensureSweeper();
  const cwd = await canonicalCwd(opts.cwd);
  const isolatedKey = `${opts.fullAccess ? "full" : "safe"}\0${cwd}\0${key}`;
  const entry = await pool.acquire(isolatedKey, opts.poolMax, async () => {
    const ctx = await getTree(cwd, opts.fullAccess);
    const agents = ctx.get("agents");
    const defaultModel = ctx.get("agentDefaultModel");
    const persistence = ctx.get("sessionPersistence");
    if (!agents || !defaultModel || !persistence) {
      throw new Error("[pi-dsh] dsh tree is missing agents/agentDefaultModel/sessionPersistence");
    }
    const selection = defaultModel.currentSelection();
    const sid = deterministicSessionId(isolatedKey);
    const target = opts.model?.provider && opts.model.model
      ? { provider: opts.model.provider, model: opts.model.model,
          ...(opts.model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(opts.model.reasoningEffort) } : {}) }
      : { provider: selection.provider, model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) };
    const persisted = await persistence.list()
      .then((headers) => headers.some((header) => header.id === sid))
      .catch(() => false);
    const makeOptions = () => ({
      agentOptions: target,
      setup: (agentCtx: Context): void => {
        installModelSelection(agentCtx, { current: target, assembled: undefined });
      },
    });
    const handle = persisted
      ? await agents.resume({ resumeSessionId: SessionId(sid), ...makeOptions() })
      : await agents.create({ sessionId: SessionId(sid), meta: { cwd }, ...makeOptions() });
    await handle.agent.whenIdle();
    return {
      key: isolatedKey, cwd, sessionId: sid, lastUsedAt: Date.now(),
      idleTtlMs: opts.idleTtlMs, activeUses: 0, fullAccess: opts.fullAccess,
      agent: handle.agent, handle, turnLock: Promise.resolve(),
    };
  });
  if (opts.approvalAnswerer) approvalAnswerers.set(entry.agent, opts.approvalAnswerer);
  return entry;
}

/** Flush the session log to persistence and dispose the agent handle. */
export async function destroyAgent(entry: AgentEntry): Promise<void> {
  await pool.remove(entry);
}

/**
 * Drive one turn: subscribe the session/event firehose, follow up with `text`,
 * wait for quiescence, and flush the session to persistence (so a later
 * cross-process resume sees the whole log). `onEvent` fires synchronously per
 * session event. On `signal` abort the active turn is cancelled WITHOUT
 * destroying the entry (droid rule: abort preserves the session). Turns on one
 * entry are serialized.
 */
export async function runTurn(
  entry: AgentEntry,
  text: string,
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
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "user" },
        }),
      );
      await agent.whenIdle();
    } finally {
      unsub?.();
      if (signal) signal.removeEventListener("abort", abortHandler);
      // Persist this turn so cross-process resume keeps the full history.
      try {
        const ctx = await getTree(entry.cwd, entry.fullAccess);
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
