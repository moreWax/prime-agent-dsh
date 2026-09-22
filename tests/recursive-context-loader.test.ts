import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextObjectStore, ContextObjectSyncResult } from "../src/context-objects.js";
import { RecursiveContextLoader } from "../src/recursive-context-loader.js";

type Handler = (event: { messages?: readonly unknown[] }, ctx: ExtensionContext) => Promise<void> | void;

function context(id: string): ExtensionContext {
  const value = {
    cwd: `/workspace/${id}`,
    ui: { notify() {} },
    sessionManager: { getSessionId: () => id },
    setTimeout: (callback: () => void | Promise<void>, ms: number) => setTimeout(() => { void callback(); }, ms),
    clearTimeout: (handle: ReturnType<typeof setTimeout> | undefined) => clearTimeout(handle),
  };
  return new Proxy({} as ExtensionContext, { get: (_target, key) => Reflect.get(value, key) });
}

function fixture(sync: (ctx: ExtensionContext, messages: readonly unknown[]) => Promise<ContextObjectSyncResult | undefined>) {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as Pick<ExtensionAPI, "on">;
  const loader = new RecursiveContextLoader({ sync } as unknown as ContextObjectStore);
  loader.register(pi);
  return { handlers, loader };
}

async function emit(handlers: Map<string, Handler[]>, event: string, payload: { messages?: readonly unknown[] }, ctx: ExtensionContext) {
  for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
}

test("recursive loader isolates root and RLM child scopes", async () => {
  const calls: string[] = [];
  const { handlers, loader } = fixture(async (ctx) => {
    const id = ctx.sessionManager.getSessionId();
    calls.push(id);
    return {
      root: `/tmp/${id}`,
      manifest: {
        version: "prime-agent-dsh/context-object-v1",
        sessionId: id,
        branchId: `${id}-leaf`,
        revision: 1,
        observedAt: 1,
        messageCount: 1,
        entryCount: 1,
        cropped: false,
        syncMode: "rebuild",
        commonPrefixMessages: 0,
        metrics: { assistantMessages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
        digest: "a".repeat(64),
        snapshot: `objects/${"a".repeat(64)}.json`,
      },
    };
  });
  const root = context("root");
  const child = context("child");
  await emit(handlers, "session_start", {}, root);
  await emit(handlers, "session_start", {}, child);
  loader.setEnabled(root, false);
  await emit(handlers, "context", { messages: [{ role: "user", content: "root" }] }, root);
  await emit(handlers, "context", { messages: [{ role: "user", content: "child" }] }, child);
  assert.deepEqual(calls, ["root", "child", "child"]);
  assert.equal(loader.status(root)?.syncs, 1);
  assert.equal(loader.status(child)?.syncs, 2);
  assert.equal(loader.status(child)?.lastSync?.manifest.sessionId, "child");
  await emit(handlers, "message_end", {}, child);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(loader.status(child)?.syncs, 3, "message_end timer observes the committed message");
  await emit(handlers, "turn_end", {}, child);
  assert.equal(loader.status(child)?.syncs, 4);
  await emit(handlers, "session_compact", {}, child);
  assert.equal(loader.status(child)?.syncs, 5);
  await emit(handlers, "session_shutdown", {}, child);
  assert.equal(calls.filter((id) => id === "child").length, 6, "shutdown performs one final durability sync");
  assert.equal(loader.status(child), undefined);
  assert(loader.status(root));
});

test("one scope fails open without disabling another scope", async () => {
  const { handlers, loader } = fixture(async (ctx) => {
    if (ctx.sessionManager.getSessionId() === "bad") throw new Error("projection failed");
    return undefined;
  });
  const bad = context("bad");
  const good = context("good");
  await emit(handlers, "session_start", {}, bad);
  await emit(handlers, "session_start", {}, good);
  await emit(handlers, "context", { messages: [] }, bad);
  await emit(handlers, "context", { messages: [] }, good);
  assert.equal(loader.status(bad)?.errors, 2);
  assert.equal(loader.status(bad)?.lastError, "projection failed");
  assert.equal(loader.status(good)?.errors, 0);
  assert.equal(loader.status(good)?.syncs, 2);
});


test("context publication is nonblocking, coalesces to latest, and never reuses the host context", async () => {
  let release: (() => void) | undefined;
  let call = 0;
  const seen: Array<readonly unknown[]> = [];
  const { handlers } = fixture(async (_ctx, messages) => {
    call++;
    seen.push(messages);
    if (call === 2) await new Promise<void>((resolve) => { release = resolve; });
    return undefined;
  });
  let stale = false;
  const base = context("coalesced");
  const guarded = new Proxy(base, { get(target, key, receiver) { if (stale) throw new Error("stale ExtensionContext accessed"); return Reflect.get(target, key, receiver); } });
  await emit(handlers, "session_start", {}, guarded);
  const first = emit(handlers, "context", { messages: [{ id: 1, role: "user" }] }, guarded);
  await first;
  for (let index = 2; index <= 40; index++) await emit(handlers, "context", { messages: [{ id: index, role: "user" }] }, guarded);
  stale = true;
  release?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(call, 3, "one in-flight publication plus one latest dirty publication");
  assert.deepEqual((seen.at(-1)?.[0] as { id?: number }).id, 40);
});

test("a rebound scope ignores late completion from the old binding", async () => {
  let release: (() => void) | undefined;
  let calls = 0;
  const { handlers, loader } = fixture(async () => {
    calls++;
    if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
    return undefined;
  });
  const make = (cwd: string) => new Proxy({} as ExtensionContext, { get: (_target, key) => Reflect.get({
    cwd, ui: { notify() {} }, sessionManager: { getSessionId: () => "same", getSessionFile: () => `/tmp/${cwd}.jsonl`, getBranch: () => [] },
  }, key) });
  const oldCtx = make("old"), nextCtx = make("new");
  const oldStart = emit(handlers, "session_start", {}, oldCtx);
  await new Promise((resolve) => setImmediate(resolve));
  const nextStart = emit(handlers, "session_start", {}, nextCtx);
  release?.();
  await Promise.all([oldStart, nextStart]);
  assert.equal(loader.status(nextCtx)?.bindingKey.includes("new.jsonl"), true);
  await emit(handlers, "session_shutdown", {}, oldCtx);
  assert(loader.status(nextCtx), "stale shutdown must not delete the rebound scope");
});


test("capacity refusal fails publication off until explicitly re-armed", async () => {
  let calls = 0;
  const { handlers, loader } = fixture(async () => {
    calls++;
    if (calls === 1) { const error = new Error("durable context quota exceeded"); error.name = "DurablePublicationUnavailableError"; throw error; }
    return undefined;
  });
  const ctx = context("quota");
  await emit(handlers, "session_start", {}, ctx);
  assert.equal(loader.isEnabled(ctx), false);
  await emit(handlers, "context", { messages: [] }, ctx);
  await emit(handlers, "turn_end", {}, ctx);
  assert.equal(calls, 1, "blocked scope must not retry on every lifecycle hook");
  loader.setEnabled(ctx, true);
  await emit(handlers, "turn_end", {}, ctx);
  assert.equal(calls, 2);
  assert.equal(loader.isEnabled(ctx), true);
});

test("latest provider cache efficiency is available for the footer status", async () => {
  const { handlers, loader } = fixture(async () => undefined);
  const ctx = context("cache-status");
  await emit(handlers, "session_start", {}, ctx);
  await emit(handlers, "context", { messages: [
    { role: "assistant", usage: { input: 20, cacheRead: 80, cacheWrite: 0 } },
    { role: "assistant", usage: { input: 5, cacheRead: 95, cacheWrite: 0 } },
  ] }, ctx);
  assert.equal(loader.status(ctx)?.latestCache?.efficiency, .95);
  assert.equal(loader.status(ctx)?.latestCache?.cacheReadTokens, 95);
});
