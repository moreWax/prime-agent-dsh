import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createModelWrapper, DSH_CONTEXT_PROVIDER } from "../src/model-wrapper.js";

const source: Model<Api> = {
  provider: "native-test",
  id: "same/model",
  name: "Same Model",
  api: "openai-completions",
  baseUrl: "https://native.invalid/v1",
  reasoning: true,
  thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
  input: ["text", "image"],
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  contextWindow: 100_000,
  maxTokens: 8_192,
};
const context = { systemPrompt: "system", messages: [], tools: [] } as Context;

function completedMessage(): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text: "exact" }], api: source.api,
    provider: source.provider, model: source.id, usage: { input: 1, output: 1, cacheRead: 0,
      cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 1 };
}

test("wrapper calls the injected original stream and forwards exact event objects", async () => {
  const message = completedMessage();
  const events: AssistantMessageEvent[] = [
    { type: "start", partial: message },
    { type: "text_delta", contentIndex: 0, delta: "exact", partial: message },
    { type: "done", reason: "stop", message },
  ];
  let calledModel: Model<Api> | undefined;
  let calledContext: Context | undefined;
  let calledOptions: SimpleStreamOptions | undefined;
  let loadedApi: Api | undefined;
  const fake = (model: Model<Api>, passedContext: Context, options?: SimpleStreamOptions) => {
    calledModel = model; calledContext = passedContext; calledOptions = options;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => { for (const event of events) stream.push(event); stream.end(message); });
    return stream;
  };
  const wrapper = createModelWrapper([source], async () => ({ ok: true, apiKey: "secret",
    headers: { "x-source": "auth", "x-shared": "source" }, baseUrl: "https://fresh.invalid/v1", env: { SOURCE: "yes" } }),
    async (api) => { loadedApi = api; return fake; });
  assert.equal(wrapper.models.length, 1);
  assert.notEqual(wrapper.models[0]!.id, source.id);
  const wrappedModel = { ...source, ...wrapper.models[0], provider: DSH_CONTEXT_PROVIDER } as Model<Api>;
  const options: SimpleStreamOptions = { apiKey: "wrapper-key", headers: { "x-call": "yes", "x-shared": "call" }, env: { CALL: "yes" } };
  const actual: AssistantMessageEvent[] = [];
  for await (const event of wrapper.streamSimple(wrappedModel, context, options)) actual.push(event);
  assert.equal(loadedApi, source.api);
  assert.equal(calledModel?.provider, source.provider);
  assert.equal(calledModel?.baseUrl, "https://fresh.invalid/v1");
  assert.equal(calledContext, context);
  assert.equal(calledOptions?.apiKey, "secret");
  assert.deepEqual(calledOptions?.headers, { "x-source": "auth", "x-shared": "call", "x-call": "yes" });
  assert.deepEqual(calledOptions?.env, { CALL: "yes", SOURCE: "yes" });
  assert.equal(actual.length, events.length);
  actual.forEach((event, index) => assert.equal(event, events[index]));
});

test("wrapper excludes itself and fails closed on source auth errors", async () => {
  const self = { ...source, provider: DSH_CONTEXT_PROVIDER };
  let dispatched = false;
  const wrapper = createModelWrapper([self, source], async () => ({ ok: false, error: "login required" }),
    async () => { dispatched = true; throw new Error("must not load"); });
  assert.equal(wrapper.models.length, 1);
  const wrappedModel = { ...source, ...wrapper.models[0], provider: DSH_CONTEXT_PROVIDER } as Model<Api>;
  const events: AssistantMessageEvent[] = [];
  for await (const event of wrapper.streamSimple(wrappedModel, context)) events.push(event);
  assert.equal(dispatched, false);
  assert.equal(events.at(-1)?.type, "error");
  const terminal = events.at(-1);
  if (terminal?.type === "error") assert.match(terminal.error.errorMessage ?? "", /login required/);
});

test("wrapper IDs distinguish identical model IDs owned by different providers", () => {
  const second = { ...source, provider: "other-native" };
  const wrapper = createModelWrapper([source, second], async () => ({ ok: true }), async () => { throw new Error("unused"); });
  assert.equal(wrapper.models.length, 2);
  assert.notEqual(wrapper.models[0]!.id, wrapper.models[1]!.id);
});
