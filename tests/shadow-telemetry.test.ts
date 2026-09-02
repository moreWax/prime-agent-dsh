import assert from "node:assert/strict";
import test from "node:test";
import { ShadowContextTelemetry } from "../src/shadow-telemetry.js";

test("telemetry is session keyed and records the current branch", () => {
  const telemetry = new ShadowContextTelemetry(2);
  const payload = { messages: [{ role: "user", content: "secret body" }] };
  const original = JSON.stringify(payload);
  telemetry.observe("context", payload, { sessionId: "s1", branchId: "leaf-a" });
  telemetry.observe("context", payload, { sessionId: "s1", branchId: "leaf-b" });
  telemetry.observe("before_provider_request", { model: "m" }, { sessionId: "s2", branchId: "leaf-x" });
  assert.equal(JSON.stringify(payload), original);
  assert.equal(telemetry.status("s1", "leaf-b")?.branchId, "leaf-b");
  assert.equal(telemetry.status("s1", "leaf-a")?.observations, 2);
  assert.equal(telemetry.status("s1", "leaf-b")?.observations, 2);
  assert.equal(telemetry.traces().length, 2);
  assert.doesNotMatch(JSON.stringify(telemetry.status("s1")), /secret body/);
});

test("observation failures are fail-open", () => {
  const telemetry = new ShadowContextTelemetry();
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  assert.equal(telemetry.observe("context", cyclic, { sessionId: "s", branchId: "b" }), undefined);
  assert.equal(telemetry.status("s")?.errors, 1);
});
