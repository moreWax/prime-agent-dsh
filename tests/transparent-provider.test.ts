import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { fallbackOnDshFailure, TransparentProviderController } from "../src/transparent-provider.js";

const model: Model<Api> = { id: "m", name: "Model", provider: "native", api: "openai-completions", baseUrl: "http://localhost", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const cfg = { dshBin: "dsh", timeoutMs: 1, mode: "pool" as const, poolMax: 1, poolIdleTtlMs: 1, fullAccess: false, mcpServers: [], persistentTerminal: false, resumeSeed: false };

function fixture() {
  const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => Promise<void> | void>>();
  const registrations: Array<[string, ProviderConfig]> = [];
  const unregistrations: string[] = [];
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> | void }>();
  let nativeCalls = 0;
  const nativeStream = (() => { nativeCalls++; return {} as AssistantMessageEventStream; }) satisfies NonNullable<ProviderConfig["streamSimple"]>;
  const partial = {
    on(event: string, handler: (event: never, ctx: ExtensionContext) => Promise<void> | void) { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); },
    registerProvider(name: string, config: ProviderConfig) { registrations.push([name, config]); },
    unregisterProvider(name: string) { unregistrations.push(name); },
    registerCommand(name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> | void }) { commands.set(name, command); },
  };
  const pi: ExtensionAPI = new Proxy({} as ExtensionAPI, { get: (_target, key) => Reflect.get(partial, key) });
  const partialCtx = { cwd: "/tmp", hasUI: false, thinkingLevel: "off", ui: { notify() {} }, modelRegistry: { getAll: () => [model] }, sessionManager: { getSessionId: () => "s" } };
  const ctx: ExtensionContext = new Proxy({} as ExtensionContext, { get: (_target, key) => Reflect.get(partialCtx, key) });
  const controller = new TransparentProviderController(pi, cfg, { dshHome: () => "/tmp", getNativeStream: () => nativeStream });
  return { controller, handlers, commands, registrations, unregistrations, nativeStream, get nativeCalls() { return nativeCalls; }, ctx };
}

test("Prime 0.9.1 registration uses (name, ProviderConfig) and keeps the catalog native", async () => {
  const f = fixture(); f.controller.register();
  await f.handlers.get("session_start")?.[0]?.({} as never, f.ctx);
  assert.equal(f.registrations.length, 1);
  const [name, config] = f.registrations[0];
  assert.equal(name, "dsh-transparent-openai-completions");
  assert.deepEqual(Object.keys(config).sort(), ["api", "streamSimple"]);
  assert.equal(config.api, model.api);
  assert.equal(f.ctx.modelRegistry.getAll()[0], model);

  // DSH runs by default: a second session_start recovers native then reinstalls.
  await f.handlers.get("session_start")?.[0]?.({} as never, f.ctx);
  assert.equal(f.unregistrations.length, 2);
  assert.equal(f.registrations.length, 2);
});




async function collect(iter: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of iter) out.push(item);
  return out;
}
interface StreamLike { [Symbol.asyncIterator](): AsyncIterator<unknown>; }
async function* events(...items: unknown[]): AsyncGenerator<unknown> { yield* items; }

test("fallback: DSH error before any content switches to the native stream", async () => {
  const dsh = events({ type: "error", error: new Error("400 developer") });
  const native = events({ type: "text", delta: "native reply" });
  let fallbackUsed = false;
  const out = await collect(fallbackOnDshFailure(dsh, () => { fallbackUsed = true; return native; }));
  assert.equal(fallbackUsed, true);
  assert.deepEqual(out, [{ type: "text", delta: "native reply" }]);
});

test("fallback: DSH content-first passes through untouched even on later errors", async () => {
  const dsh = events({ type: "text", delta: "partial" }, { type: "error", error: new Error("late") });
  const out = await collect(fallbackOnDshFailure(dsh, () => events({ type: "text", delta: "NOPE" })));
  assert.deepEqual(out, [{ type: "text", delta: "partial" }, { type: "error", error: new Error("late") }]);
});

test("fallback: DSH stream that throws before content switches to native", async () => {
  const dsh: StreamLike = {
    async *[Symbol.asyncIterator]() { throw new Error("boom"); yield undefined; },
  };
  const native = events({ type: "text", delta: "saved" });
  const out = await collect(fallbackOnDshFailure(dsh, () => native));
  assert.deepEqual(out, [{ type: "text", delta: "saved" }]);
});

test("session-scoped switch: off unregisters the shim, on reinstalls it", async () => {
  const f = fixture(); f.controller.register();
  await f.handlers.get("session_start")?.[0]?.({} as never, f.ctx);
  assert.equal(f.controller.isEnabled, true);
  assert.equal(f.registrations.length, 1);

  assert.equal(f.controller.setEnabled(false, f.ctx), false);
  assert.equal(f.unregistrations.length, 2);   // recovered native
  assert.equal(f.registrations.length, 1);     // no shim reinstalled

  assert.equal(f.controller.setEnabled(true, f.ctx), true);
  assert.equal(f.unregistrations.length, 3);   // recovers again before reinstall
  assert.equal(f.registrations.length, 2);
});

test("startup/reload never captures or stacks an old wrapper", () => {
  const f = fixture();
  f.controller.captureAndPublish(f.ctx);
  f.controller.captureAndPublish(f.ctx);
  assert.equal(f.unregistrations.length, 2);
  assert.equal(f.registrations.length, 2);
  assert.notEqual(f.registrations[0][1].streamSimple, f.nativeStream);
  assert.notEqual(f.registrations[1][1].streamSimple, f.registrations[0][1].streamSimple);
  assert.equal(f.nativeCalls, 0);
});
