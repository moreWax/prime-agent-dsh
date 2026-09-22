import assert from "node:assert/strict";
import test from "node:test";
import { cacheFooterText, compactTokenCount } from "../extensions/index.js";

test("cache footer combines latest cache efficiency with Prime context usage", () => {
  assert.equal(cacheFooterText(.99684, { tokens: 563_698, contextWindow: 1_000_000, percent: 56.3698 }),
    "DSH cache 99.7% · ctx 564K/1.0M · 56.4%");
  assert.equal(cacheFooterText(undefined, { tokens: null, contextWindow: 1_000_000, percent: null }),
    "DSH cache — · ctx — · —");
  assert.equal(compactTokenCount(999), "999");
  assert.equal(compactTokenCount(12_345), "12K");
});
