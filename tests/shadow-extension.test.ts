import assert from "node:assert/strict";
import test from "node:test";
import { ShadowMirrorController, shadowOptions } from "../extensions/shadow-context.js";

const user = { id: "u1", message: { role: "user", content: [{ type: "text", text: "hello" }] } };
const assistant = { id: "a1", message: { role: "assistant", content: [{ type: "text", text: "world" }], provider: "p", model: "m" } };

void test("shadow mirror controller owns rebuild, noop, and append lifecycle", async () => {
  const mirror = new ShadowMirrorController();
  await mirror.observe([user], { sessionId: "session", branchId: "root" });
  await mirror.observe([user], { sessionId: "session", branchId: "root" });
  await mirror.observe([user, assistant], { sessionId: "session", branchId: "root" });
  assert.deepEqual(mirror.counters, { syncs: 3, skips: 0, errors: 0, appends: 1, noops: 1, rebuilds: 1 });
});

void test("shadow mirror controller remains fail-open for unsupported Prime input", async () => {
  const mirror = new ShadowMirrorController();
  await assert.doesNotReject(mirror.observe([{ content: "missing role" }], { sessionId: "session", branchId: "root" }));
  assert.equal(mirror.counters.errors, 1);
});

void test("shadow workload is opt-in and bounded by default", () => {
  const options = shadowOptions({});
  assert.equal(options.mode, "off");
  assert.equal(options.maxMessages, 500);
  assert.equal(options.maxBytes, 4 * 1024 * 1024);
  assert.equal(shadowOptions({ PRIME_DSH_SHADOW_MODE: "on", PRIME_DSH_SHADOW_MAX_MESSAGES: "12" }).mode, "on");
});
