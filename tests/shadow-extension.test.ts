import assert from "node:assert/strict";
import test from "node:test";
import { ShadowMirrorController } from "../extensions/shadow-context.js";

const user = { id: "u1", message: { role: "user", content: [{ type: "text", text: "hello" }] } };
const assistant = { id: "a1", message: { role: "assistant", content: [{ type: "text", text: "world" }], provider: "p", model: "m" } };

void test("shadow mirror controller owns rebuild, noop, and append lifecycle", () => {
  const mirror = new ShadowMirrorController();
  mirror.observe([user], { sessionId: "session", branchId: "root" });
  mirror.observe([user], { sessionId: "session", branchId: "root" });
  mirror.observe([user, assistant], { sessionId: "session", branchId: "root" });
  assert.deepEqual(mirror.counters, { syncs: 3, skips: 0, errors: 0, appends: 1, noops: 1, rebuilds: 1 });
});

void test("shadow mirror controller remains fail-open for unsupported Prime input", () => {
  const mirror = new ShadowMirrorController();
  assert.doesNotThrow(() => mirror.observe([{ content: "missing role" }], { sessionId: "session", branchId: "root" }));
  assert.equal(mirror.counters.errors, 1);
});
