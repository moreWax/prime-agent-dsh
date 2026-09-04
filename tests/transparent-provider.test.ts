import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Provider } from "@earendil-works/pi-ai";
import { TransparentProviderController } from "../src/transparent-provider.js";

const model = { id: "m", name: "Model", provider: "native", api: "openai-completions", baseUrl: "http://localhost", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as unknown as import("@earendil-works/pi-ai").Model<Api>;

test("transparent wrapper preserves provider identity, catalog, auth and supports native opt-out", () => {
  const auth = { apiKey: { name: "key", login: async () => ({ type: "api_key" as const, key: "x" }), check: async () => ({ type: "api_key" as const, source: "test" }), resolve: async () => ({ auth: { apiKey: "x" }, source: "test" }) } };
  const nativeStream = {} as ReturnType<Provider<Api>["streamSimple"]>;
  const native: Provider<Api> = { id: "native", name: "Native", auth, getModels: () => [model], stream: () => nativeStream, streamSimple: () => nativeStream };
  let registered: Provider<Api> | undefined;
  const pi = { on() {}, registerProvider(provider: Provider<Api>) { registered = provider; }, registerCommand() {} };
  const ctx = { cwd: "/tmp", modelRegistry: { getAll: () => [model], getProvider: () => native }, sessionManager: { getSessionId: () => "s" } };
  const cfg = { dshBin: "dsh", timeoutMs: 1, mode: "pool" as const, poolMax: 1, poolIdleTtlMs: 1, fullAccess: false, transparent: false, mcpServers: [], persistentTerminal: false };
  const controller = new TransparentProviderController(pi as never, cfg, { dshHome: () => "/tmp" });
  controller.register(); controller.captureAndPublish(ctx as never);
  assert.equal(registered?.id, "native");
  assert.equal(registered?.auth, auth);
  assert.equal(registered?.getModels()[0], model);
  assert.equal(registered?.streamSimple(model as never, { messages: [], tools: [] }), nativeStream);
  assert.equal(controller.isEnabled, false);
});
