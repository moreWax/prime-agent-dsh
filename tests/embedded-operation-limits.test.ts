import assert from "node:assert/strict";
import test from "node:test";
import { EMBEDDED_OPERATION_LIMITS as limits } from "../src/dsh-provider-host.js";

test("embedded DSH work has conservative fixed fan-out and wait bounds", () => {
  assert.deepEqual(limits, {
    subagentMaxDepth: 2,
    workflowMaxConcurrentAgents: 4,
    workflowMaxTotalAgents: 16,
    workflowMaxItemsPerCall: 64,
    workflowSyncTimeoutMs: 2_000,
    workflowDisposeGraceMs: 2_000,
    jobWaitTimeoutMs: 5_000,
    jobMaxWaitTimeoutMs: 30_000,
  });
  assert.ok(limits.workflowMaxConcurrentAgents <= limits.workflowMaxTotalAgents);
  assert.ok(limits.jobWaitTimeoutMs <= limits.jobMaxWaitTimeoutMs);
});
