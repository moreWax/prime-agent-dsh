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
        snapshot: "snapshots/a.json",
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
  await emit(handlers, "turn_end", {}, child);
  assert.equal(loader.status(child)?.syncs, 3);
  await emit(handlers, "session_compact", {}, child);
  assert.equal(loader.status(child)?.syncs, 4);
  await emit(handlers, "session_shutdown", {}, child);
  assert.equal(calls.filter((id) => id === "child").length, 5, "shutdown performs one final durability sync");
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
