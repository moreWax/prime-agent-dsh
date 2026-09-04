import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model, type Provider } from "@earendil-works/pi-ai";
import { wrapNativeProvider } from "../src/transparent-routing.js";

const model: Model<Api> = { provider: "native", id: "m", name: "M", api: "openai-completions", baseUrl: "https://example.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
const context = { systemPrompt: "", messages: [], tools: [] } as Context;
function result(text: string): AssistantMessage { return { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 }; }
function finished(text: string) { const out = result(text); const stream = createAssistantMessageEventStream(); queueMicrotask(() => { stream.push({ type: "start", partial: out }); stream.push({ type: "done", reason: "stop", message: out }); stream.end(out); }); return stream; }

test("transparent decorator preserves native identity, catalog and auth but routes streams", async () => {
  let originalCalls = 0, routedCalls = 0;
  const auth: Provider["auth"] = { apiKey: { name: "native", resolve: async () => ({ auth: { apiKey: "secret" } }) } };
  const original: Provider<Api> = { id: "native", name: "Native", baseUrl: model.baseUrl, auth, getModels: () => [model], stream: () => { originalCalls++; return finished("original"); }, streamSimple: () => { originalCalls++; return finished("original"); } };
  const wrapped = wrapNativeProvider(original, (passed, _ctx, options) => { routedCalls++; assert.equal(passed, model); assert.equal(options?.apiKey, "resolved"); return finished("dsh"); });
  assert.equal(wrapped.id, original.id); assert.equal(wrapped.name, original.name); assert.equal(wrapped.auth, auth); assert.equal(wrapped.getModels()[0], model);
  const message = await wrapped.streamSimple(model, context, { apiKey: "resolved" }).result();
  assert.equal(message.content[0]?.type === "text" && message.content[0].text, "dsh");
  assert.equal(routedCalls, 1); assert.equal(originalCalls, 0);
});

test("transparent decorator preserves deferred operations on the concrete provider", async () => {
  let fetched = false, cancelled = false;
  const original = { id: "native", name: "Native", auth: { apiKey: { name: "x", resolve: async () => ({ auth: {} }) } }, getModels: () => [model], stream: () => finished("x"), streamSimple: () => finished("x"), fetchDeferred: () => { fetched = true; return finished("deferred"); }, cancelDeferred: async () => { cancelled = true; } } satisfies Provider<Api>;
  const wrapped = wrapNativeProvider(original, () => finished("dsh"));
  await wrapped.fetchDeferred!(model, { id: "h", provider: "native", modelId: "m", api: "x" }, {}).result();
  await wrapped.cancelDeferred!(model, { id: "h", provider: "native", modelId: "m", api: "x" }, {});
  assert.equal(fetched, true); assert.equal(cancelled, true);
});
