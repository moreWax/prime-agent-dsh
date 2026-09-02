import assert from "node:assert/strict";
import test from "node:test";
import { dshSessionId } from "../src/session.js";

test("session ids are stable and branch scoped", () => {
  assert.equal(dshSessionId("prime-a", "leaf-a"), dshSessionId("prime-a", "leaf-a"));
  assert.notEqual(dshSessionId("prime-a", "leaf-a"), dshSessionId("prime-a", "leaf-b"));
  assert.match(dshSessionId("prime-a", "leaf-a"), /^prime-[a-f0-9]{32}$/);
});
