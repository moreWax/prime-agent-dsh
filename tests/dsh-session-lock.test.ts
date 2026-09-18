import assert from "node:assert/strict";
import test from "node:test";
import { withDshSessionLock } from "../src/dsh-provider-host.js";

function deferred<T = void>(): { promise: Promise<T>; resolve(value?: T | PromiseLike<T>): void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = (value) => done(value as T | PromiseLike<T>); });
  return { promise, resolve };
}

test("DSH SID mutex serializes the full source operation", async () => {
  const order: string[] = [];
  const entered = deferred<void>();
  const release = deferred<void>();
  const first = withDshSessionLock("source", async () => {
    order.push("first:start");
    entered.resolve();
    await release.promise;
    order.push("first:end");
  });
  await entered.promise;
  const second = withDshSessionLock("source", async () => { order.push("second"); });
  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

test("DSH SID mutex does not block independent sessions", async () => {
  const blocked = deferred<void>();
  const first = withDshSessionLock("a", () => blocked.promise);
  let ran = false;
  await withDshSessionLock("b", async () => { ran = true; });
  assert.equal(ran, true);
  blocked.resolve();
  await first;
});
