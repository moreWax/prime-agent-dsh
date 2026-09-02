import assert from "node:assert/strict";
import test from "node:test";
import { commonPrefixBytes, PrefixTracker, stableJson } from "../src/prefix-metrics.js";

test("stable JSON sorts keys, removes credentials, and fingerprints consistently", () => {
  assert.equal(stableJson({ z: 1, authorization: "secret", a: { token: "x", b: 2 } }), '{"a":{"b":2,"token":"[REDACTED]"},"authorization":"[REDACTED]","z":1}');
  const a = new PrefixTracker().measure({ b: 2, a: 1 });
  const b = new PrefixTracker().measure({ a: 1, b: 2 });
  assert.equal(a.digest, b.digest);
});

test("LCP is measured in UTF-8 bytes", () => {
  assert.equal(commonPrefixBytes("éx", "éy"), 2);
});

test("tracker reports append and rewrite without retaining public payload", () => {
  const tracker = new PrefixTracker();
  assert.equal(tracker.measure("a".repeat(100)).reason, "initial");
  const appended = tracker.measure("a".repeat(101));
  assert.equal(appended.reason, "append");
  assert.equal(appended.commonPrefixBytes, 101); // quote plus 100 payload bytes
  assert.equal(tracker.measure("xyz").reason, "model-or-envelope");
});
