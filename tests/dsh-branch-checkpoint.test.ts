import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DSH_CHECKPOINT_CUSTOM_TYPE,
  deriveBaseDshSessionId,
  deriveForkedDshSessionId,
  findLatestPrimeUserEntryId,
  findNearestDshBranchCheckpoint,
  parseDshBranchCheckpoint,
  parseDshBranchCheckpointEntry,
} from "../src/dsh-branch-checkpoint.js";

const data = {
  version: 1,
  primeSessionId: "prime-session",
  primeTurnEntryId: "user-1",
  dshSessionId: "dsh_source-1.2",
  dshBoundarySeq: 17,
  outcome: "stop",
} as const;

function entry(overrides: Record<string, unknown> = {}) {
  return {
    type: "custom",
    id: "checkpoint-1",
    parentId: data.primeTurnEntryId,
    customType: DSH_CHECKPOINT_CUSTOM_TYPE,
    data,
    ...overrides,
  };
}

test("parses and normalizes valid v1 checkpoint data", () => {
  const parsed = parseDshBranchCheckpoint({ ...data, futureField: true });
  assert.deepEqual(parsed, data);
  assert.notEqual(parsed, data);
});

test("rejects malformed checkpoint data and unknown versions", () => {
  const invalid: unknown[] = [
    undefined,
    null,
    [],
    { ...data, version: 2 },
    { ...data, primeSessionId: "" },
    { ...data, primeTurnEntryId: 4 },
    { ...data, dshSessionId: "has spaces" },
    { ...data, dshSessionId: "x".repeat(129) },
    { ...data, dshBoundarySeq: -1 },
    { ...data, dshBoundarySeq: 1.5 },
    { ...data, dshBoundarySeq: Number.MAX_SAFE_INTEGER + 1 },
    { ...data, outcome: "error" },
  ];
  for (const value of invalid) assert.equal(parseDshBranchCheckpoint(value), undefined);
});

test("accepts only plain checkpoint entries attached to their recorded turn", () => {
  assert.deepEqual(parseDshBranchCheckpointEntry(entry()), data);
  assert.equal(parseDshBranchCheckpointEntry(entry({ type: "custom_message" })), undefined);
  assert.equal(parseDshBranchCheckpointEntry(entry({ customType: "other" })), undefined);
  assert.equal(parseDshBranchCheckpointEntry(entry({ parentId: "other-turn" })), undefined);
  assert.equal(parseDshBranchCheckpointEntry(entry({ data: { ...data, version: 2 } })), undefined);
});

test("scans backward for the nearest valid checkpoint and skips malformed entries", () => {
  const older = { ...data, dshSessionId: "older", dshBoundarySeq: 4 };
  const newer = { ...data, dshSessionId: "newer", dshBoundarySeq: 9, outcome: "incomplete" as const };
  const branch = [
    entry({ id: "old", data: older }),
    { type: "message", id: "assistant", message: { role: "assistant" } },
    entry({ id: "bad", parentId: "wrong", data: newer }),
    entry({ id: "new", data: newer }),
    { type: "message", id: "tail", message: { role: "assistant" } },
  ];
  assert.deepEqual(findNearestDshBranchCheckpoint(branch), newer);
  assert.equal(findNearestDshBranchCheckpoint([entry({ parentId: "wrong" })]), undefined);
});

test("finds only the latest persisted Prime user message entry", () => {
  const branch = [
    { type: "message", id: "u1", message: { role: "user" } },
    entry(),
    { type: "message", id: "a1", message: { role: "assistant" } },
    { type: "custom_message", id: "not-user", message: { role: "user" } },
    { type: "message", id: "u2", message: { role: "user" } },
    { type: "message", id: "broken", message: null },
  ];
  assert.equal(findLatestPrimeUserEntryId(branch), "u2");
  assert.equal(findLatestPrimeUserEntryId([{ type: "message", id: "a", message: { role: "assistant" } }]), undefined);
});

test("derives documented deterministic and DSH-valid session IDs", () => {
  const expectedFork = `pi-${createHash("sha256")
    .update(["fork", "prime-session", "user-1", "source-1", "17"].join("\0"), "utf8")
    .digest("hex")
    .slice(0, 32)}`;
  const expectedBase = `pi-${createHash("sha256")
    .update("base\0prime-session\0user-1", "utf8")
    .digest("hex")
    .slice(0, 32)}`;
  assert.equal(deriveForkedDshSessionId("prime-session", "user-1", "source-1", 17), expectedFork);
  assert.equal(deriveForkedDshSessionId("prime-session", "user-1", "source-1", 17), expectedFork);
  assert.equal(deriveBaseDshSessionId("prime-session", "user-1"), expectedBase);
  assert.match(expectedFork, /^pi-[a-f0-9]{32}$/);
});

test("deterministic IDs separate sessions, branches, sources, and boundaries", () => {
  const fork = deriveForkedDshSessionId("p", "u", "s", 1);
  assert.notEqual(fork, deriveForkedDshSessionId("p2", "u", "s", 1));
  assert.notEqual(fork, deriveForkedDshSessionId("p", "u2", "s", 1));
  assert.notEqual(fork, deriveForkedDshSessionId("p", "u", "s2", 1));
  assert.notEqual(fork, deriveForkedDshSessionId("p", "u", "s", 2));
  assert.notEqual(deriveBaseDshSessionId("p", "u"), deriveBaseDshSessionId("p", "u2"));
});
