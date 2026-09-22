import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableContextStore } from "../src/durable-context-store.js";

async function setup(entries: unknown[]) {
  const temporary = await mkdtemp(join(tmpdir(), "dsh-prime-index-"));
  const session = join(temporary, "prime.jsonl");
  await writeFile(session, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""), "utf8");
  const root = join(temporary, "store");
  const make = () => new DurableContextStore({ root, binding: { sessionId: "indexed", primeSessionFile: session }, minFreeBytes: 1 });
  const publish = (store: DurableContextStore, source: unknown[], branchId = "root") => store.publish({ source, effective: source, converterVersion: "c", schemaVersion: "s", branchId });
  return { temporary, session, root, make, publish };
}

test("Prime index scans once, tails appends, and survives restart without message bodies", async () => {
  const secret = "TOP-SECRET-BODY-9d4f"; const one = { id: "one", message: { role: "user", content: secret } };
  const f = await setup([one]); const first = await f.publish(f.make(), [one]);
  assert.deepEqual(first.publication.index, { mode: "full", bytesProcessed: (await stat(f.session)).size, linesProcessed: 1 });
  const two = { id: "two", message: { role: "assistant", content: "second" } }; const encoded = `${JSON.stringify(two)}\n`;
  await appendFile(f.session, encoded); const second = await f.publish(f.make(), [one, two]);
  assert.deepEqual(second.publication.index, { mode: "tail", bytesProcessed: Buffer.byteLength(encoded), linesProcessed: 1 });
  const cached = await f.publish(f.make(), [one, two], "other-branch");
  assert.deepEqual(cached.publication.index, { mode: "cache", bytesProcessed: 0, linesProcessed: 0 });
  const metadata = await readFile(join(f.root, "indexes", "prime-jsonl.json"), "utf8");
  assert.doesNotMatch(metadata, /TOP-SECRET-BODY-9d4f|second/); assert.match(metadata, /"id":"one"/);
  await rm(f.temporary, { recursive: true, force: true });
});

test("Prime index rebuilds on truncation, inode replacement, and cursor tampering", async () => {
  const one = { id: "one", text: "a" }, two = { id: "two", text: "b" }; const f = await setup([one, two]);
  await f.publish(f.make(), [one, two]);
  await truncate(f.session, Buffer.byteLength(`${JSON.stringify(one)}\n`));
  const truncated = await f.publish(f.make(), [one], "truncated"); assert.equal(truncated.publication.index?.mode, "full");
  const replacement = join(f.temporary, "replacement.jsonl"); await writeFile(replacement, `${JSON.stringify(one)}\n${JSON.stringify(two)}\n`); await rename(replacement, f.session);
  const replaced = await f.publish(f.make(), [one, two], "replaced"); assert.equal(replaced.publication.index?.mode, "full");
  const cursor = join(f.root, "indexes", "prime-jsonl.json"); await writeFile(cursor, '{"entries":[{"message":"LEAK"}]}\n');
  const recovered = await f.publish(f.make(), [one, two], "recovered"); assert.equal(recovered.publication.index?.mode, "full");
  assert.doesNotMatch(await readFile(cursor, "utf8"), /LEAK/);
  await rm(f.temporary, { recursive: true, force: true });
});

test("verified locator reads fail closed after Prime bytes are changed", async () => {
  const one = { id: "one", text: "original" }; const f = await setup([one]); const store = f.make(); await f.publish(store, [one]);
  await writeFile(f.session, `${JSON.stringify({ id: "one", text: "tampered" })}\n`);
  assert.equal(store.recover(), undefined);
  await rm(f.temporary, { recursive: true, force: true });
});
