import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableContextStore } from "../src/durable-context-store.js";
import { DurableContextQuery } from "../src/durable-context-query.js";

async function allBytes(root: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  async function walk(path: string): Promise<void> {
    for (const name of await readdir(path)) {
      const child = join(path, name); const info = await stat(child);
      if (info.isDirectory()) await walk(child); else chunks.push(await readFile(child));
    }
  }
  await walk(root); return Buffer.concat(chunks);
}

test("v3 roots contain only verified Prime references and source queries dereference them", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "dsh-ref-only-"));
  const session = join(temporary, "prime.jsonl"), root = join(temporary, "dsh");
  const secret = "reference-only-secret-7dce";
  const source = [{ type: "message", id: "u-1", parentId: null, message: { role: "user", content: secret } }];
  await writeFile(session, source.map(value => JSON.stringify(value)).join("\n") + "\n");
  const store = new DurableContextStore({ root, binding: { sessionId: "ref", primeSessionFile: session } });
  const published = await store.publish({ source, effective: source, branchId: "u-1", converterVersion: "c", schemaVersion: "s" });
  assert.equal(published.object.version, "prime-agent-dsh/derived-object-v3-reference");
  assert.equal(published.object.sourceLocators?.[0]?.entryId, "u-1");
  assert.equal((await allBytes(root)).includes(Buffer.from(secret)), false);
  assert.equal((await readdir(root)).includes("bodies"), false);
  const hit = new DurableContextQuery({ root, sessionId: "ref", primeSessionFile: session }).query({ query: secret, scope: "source" }).hits[0];
  assert.equal((hit?.value as {id?: string}).id, "u-1"); assert.equal(hit?.trace.exactBody, true);

  await writeFile(session, JSON.stringify({ ...source[0], message: { role: "user", content: "tampered-secret-value---" } }) + "\n");
  assert.equal(store.recover(), undefined);
  const page = new DurableContextQuery({ root, sessionId: "ref", primeSessionFile: session }).query({ query: secret, scope: "source" });
  assert.equal(page.hits.length, 0); assert.equal(page.skippedCorruptCheckpoints, 1);
});

test("a greater-than-16MiB Prime body is never duplicated into DSH", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "dsh-ref-large-"));
  const session = join(temporary, "prime.jsonl"), root = join(temporary, "dsh");
  const secret = "large-secret-marker-91ac";
  const source = [{ type: "message", id: "large", message: { role: "user", content: secret + "x".repeat(17 * 1024 * 1024) } }];
  await writeFile(session, JSON.stringify(source[0]) + "\n");
  const store = new DurableContextStore({ root, binding: { sessionId: "large", primeSessionFile: session } });
  await store.publish({ source, effective: source, converterVersion: "c", schemaVersion: "s" });
  const stored = await allBytes(root);
  assert.equal(stored.includes(Buffer.from(secret)), false);
  assert.ok(stored.length < 128 * 1024, `reference metadata unexpectedly used ${stored.length} bytes`);
});
