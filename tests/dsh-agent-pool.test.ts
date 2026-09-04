import assert from "node:assert/strict";
import test from "node:test";
import { BusyLruPool, type PoolEntry } from "../src/dsh-agent-pool.js";

interface FakeEntry extends PoolEntry { disposed?: boolean }

function entry(key: string, lastUsedAt = 0): FakeEntry {
  return { key, lastUsedAt, idleTtlMs: 10, activeUses: 0 };
}

test("deduplicates concurrent creation per key and accounts every acquisition", async () => {
  let creates = 0;
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const pool = new BusyLruPool<FakeEntry>(async () => undefined, () => 5);
  const factory = async () => { creates++; await gate; return entry("same"); };
  const first = pool.acquire("same", 2, factory);
  const second = pool.acquire("same", 2, factory);
  unblock();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(creates, 1);
  assert.equal(a.activeUses, 2);
});

test("TTL sweep and LRU eviction never dispose busy entries", async () => {
  let now = 0;
  const disposed: string[] = [];
  const pool = new BusyLruPool<FakeEntry>(async (value) => { disposed.push(value.key); }, () => now);
  const busy = await pool.acquire("busy", 2, async () => entry("busy"));
  const idle = await pool.acquire("idle", 2, async () => entry("idle"));
  pool.release(idle);
  now = 20;
  await pool.sweepExpired();
  assert.deepEqual(disposed, ["idle"]);
  assert.equal(pool.size, 1);
  const overflow = await pool.acquire("overflow", 1, async () => entry("overflow"));
  assert.equal(pool.size, 2, "temporary overflow is allowed when all prior entries are busy");
  assert.deepEqual(disposed, ["idle"]);
  pool.release(overflow);
  pool.release(busy);
});

test("release and touch update activity timestamps", async () => {
  let now = 1;
  const pool = new BusyLruPool<FakeEntry>(async () => undefined, () => now);
  const value = await pool.acquire("key", 1, async () => entry("key"));
  now = 4;
  pool.touch(value);
  assert.equal(value.lastUsedAt, 4);
  now = 9;
  pool.release(value);
  assert.equal(value.activeUses, 0);
  assert.equal(value.lastUsedAt, 9);
});
