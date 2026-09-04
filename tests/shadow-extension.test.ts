import assert from "node:assert/strict";
import test from "node:test";
import { ShadowMirrorController } from "../extensions/shadow-context.js";

const user = { id: "u1", message: { role: "user", content: [{ type: "text", text: "hello" }] } };
const assistant = { id: "a1", message: { role: "assistant", content: [{ type: "text", text: "world" }], provider: "p", model: "m" } };

test("shadow mirror controller owns rebuild, noop, and append lifecycle", () => {
  const mirror = new ShadowMirrorController();
  mirror.observe([user], "session");
  mirror.observe([user], "session");
  mirror.observe([user, assistant], "session");
  assert.deepEqual(mirror.counters, { syncs: 3, skips: 0, errors: 0, appends: 1, noops: 1, rebuilds: 1 });
});

test("shadow mirror controller remains fail-open for unsupported Prime input", () => {
  const mirror = new ShadowMirrorController();
  assert.doesNotThrow(() => mirror.observe([{ content: "missing role" }], "session"));
  assert.equal(mirror.counters.errors, 1);
});
