import assert from "node:assert/strict";
import test from "node:test";
import { cacheEpochFromBranch } from "../src/cache-epoch-diagnostics.js";

const assistant = (id: string, input: number, read: number, write: number) => ({ type: "message", id, message: { role: "assistant", usage: { input, cacheRead: read, cacheWrite: write } } });

test("cache epoch records summary usage, first-after-compaction, and stable samples", () => {
  const branch = [assistant("old", 10, 90, 0), { type: "compaction", id: "boundary-1", usage: { input: 100, cacheRead: 900, cacheWrite: 4 } },
    { type: "message", id: "u", message: { role: "user" } }, assistant("first", 30, 0, 20), assistant("steady", 5, 95, 0)];
  const epoch = cacheEpochFromBranch("session", branch);
  assert.equal(epoch.boundaryId, "boundary-1");
  assert.deepEqual(epoch.summaryRequest, { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 4 });
  assert.equal(epoch.firstAfterCompaction?.sourceIndex, 3);
  assert.equal(epoch.firstAfterCompaction?.phase, "firstAfterCompaction");
  assert.deepEqual(epoch.stable.map((sample) => [sample.sourceIndex, sample.phase]), [[4, "stable"]]);
});

test("a durable boundary transitions epoch IDs and no compaction treats samples as stable", () => {
  const before = cacheEpochFromBranch("session", [assistant("a", 1, 2, 3)]);
  assert.equal(before.firstAfterCompaction, undefined);
  assert.equal(before.stable.length, 1);
  const after = cacheEpochFromBranch("session", [assistant("a", 1, 2, 3), { type: "compaction", id: "c" }]);
  assert.notEqual(after.epochId, before.epochId);
  assert.equal(after.stable.length, 0);
});
