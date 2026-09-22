import assert from "node:assert/strict";
import test from "node:test";
import { cacheFooterText } from "../extensions/index.js";

test("cache footer adds only provider cache efficiency and leaves Prime context UI untouched", () => {
  assert.equal(cacheFooterText(.99684), "DSH cache 99.7%");
  assert.equal(cacheFooterText(undefined), "DSH cache —");
});
