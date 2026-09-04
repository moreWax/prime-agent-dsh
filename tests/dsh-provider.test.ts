import assert from "node:assert/strict";
import test from "node:test";
import { buildModels, PROVIDER_ID } from "../src/dsh-provider-catalog.js";
import { extractLatestTurn } from "../src/dsh-provider.js";
import { classifyTurnEnd, textBlockKey, thinkingBlockKey } from "../src/dsh-provider-turn-reasons.js";

test("registers DSH as a selectable provider catalog", () => {
  assert.equal(PROVIDER_ID, "dsh");
  assert.deepEqual(buildModels().map((model) => model.id), ["dsh-harness"]);
  const [configured] = buildModels();
  assert.equal(configured?.id, "dsh-harness");
  assert.match(configured?.name ?? "", /Harness/);
});

test("maps DSH loop outcomes without handing the tool loop to Prime", () => {
  assert.equal(classifyTurnEnd("completed"), "stop");
  assert.equal(classifyTurnEnd("aborted"), "aborted");
  assert.equal(classifyTurnEnd("error"), "error");
  assert.equal(classifyTurnEnd("max-tokens"), "incomplete");
  assert.notEqual(textBlockKey(1, 0), textBlockKey(2, 0));
  assert.notEqual(textBlockKey(1, 0), thinkingBlockKey(1, 0));
});


test("latest pooled turn preserves interleaved text and images", () => {
  const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
  const turn = extractLatestTurn({ messages: [
    { role: "user", content: "old", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "answer" }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
    { role: "user", content: [{ type: "text", text: "before" }, image, { type: "text", text: "after" }], timestamp: 3 },
  ], tools: [] });
  assert.deepEqual(turn.content, [{ type: "text", text: "before" }, image, { type: "text", text: "after" }]);
});
