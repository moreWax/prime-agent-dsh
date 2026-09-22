import assert from "node:assert/strict";
import test from "node:test";
import { cacheFooterText } from "../extensions/index.js";

test("cache widget distinguishes latest turn and canonical session rates", () => {
  assert.equal(cacheFooterText(.99684, .97061), "DSH cache · turn 99.7% · session 97.1%");
  assert.equal(cacheFooterText(undefined, undefined), "DSH cache · turn — · session —");
});
