import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { TransparentProviderController } from "../src/transparent-provider.js";

const model: Model<Api> = { id: "m", name: "Model", provider: "native", api: "openai-completions", baseUrl: "http://localhost", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const cfg = { dshBin: "dsh", timeoutMs: 1, mode: "pool" as const, poolMax: 1, poolIdleTtlMs: 1, fullAccess: false, transparent: true, mcpServers: [], persistentTerminal: false };

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

test("Prime 0.9.1 registration uses (name, ProviderConfig), keeps the catalog native, and disable restores native", async () => {
  const f = fixture(); f.controller.register();
  await f.handlers.get("session_start")?.[0]?.({} as never, f.ctx);
  assert.equal(f.registrations.length, 1);
  const [name, config] = f.registrations[0];
  assert.equal(name, "dsh-transparent-openai-completions");
  assert.deepEqual(Object.keys(config).sort(), ["api", "streamSimple"]);
  assert.equal(config.api, model.api);
  assert.equal(f.ctx.modelRegistry.getAll()[0], model);

  // A second session_start (or duplicate delivery) recovers native before reinstalling.
  await f.handlers.get("session_start")?.[0]?.({} as never, f.ctx);
  assert.equal(f.unregistrations.length, 2);
  assert.equal(f.registrations.length, 2);

  // The off command unregisters the API shim and leaves native dispatch installed.
  await f.commands.get("dsh-transparent")?.handler("off", f.ctx);
  assert.equal(f.controller.isEnabled, false);
  assert.equal(f.unregistrations.length, 3);
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
