import assert from "node:assert/strict";
import test from "node:test";
import { buildModels, PROVIDER_ID } from "../src/dsh-provider-catalog.js";
import { classifyTurnEnd, textBlockKey, thinkingBlockKey } from "../src/dsh-provider-turn-reasons.js";

test("registers DSH as a selectable provider catalog", () => {
  assert.equal(PROVIDER_ID, "dsh");
  assert.deepEqual(buildModels(undefined).map((model) => model.id), ["dsh-harness"]);
  const [configured] = buildModels({ provider: "deepseek", model: "deepseek-v4-pro" });
  assert.equal(configured?.id, "deepseek-v4-pro");
  assert.match(configured?.name ?? "", /DSH/);
});

test("maps DSH loop outcomes without handing the tool loop to Prime", () => {
  assert.equal(classifyTurnEnd("completed"), "stop");
  assert.equal(classifyTurnEnd("aborted"), "aborted");
  assert.equal(classifyTurnEnd("error"), "error");
  assert.equal(classifyTurnEnd("max-tokens"), "incomplete");
  assert.notEqual(textBlockKey(1, 0), textBlockKey(2, 0));
  assert.notEqual(textBlockKey(1, 0), thinkingBlockKey(1, 0));
});
