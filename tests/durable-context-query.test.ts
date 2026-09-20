import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableContextStore } from "../src/durable-context-store.js";
import { DurableContextQuery } from "../src/durable-context-query.js";

async function fixture() {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "context-query-")));
  const session = join(temporary, "prime.jsonl"); await writeFile(session, "", "utf8");
  const root = join(temporary, "store");
  const store = new DurableContextStore({ root, binding: { sessionId: "only-this", primeSessionFile: session } });
  const publish = (source: unknown[], branchId: string) => store.publish({ source, effective: source, branchId, converterVersion: "c1", schemaVersion: "s1", observedAt: 10 });
  return { temporary, session, root, store, publish };
}

test("literal, regex, and deterministic ranked queries carry exact provenance", async () => {
  const f = await fixture(); const one = await f.publish([{ text: "alpha beta" }, { text: "other" }], "main");
  await f.publish([{ text: "alpha beta" }, { text: "beta beta alpha" }], "feature");
  const query = new DurableContextQuery({ root: f.root, sessionId: "only-this", primeSessionFile: f.session });
  const literal = query.query({ query: "ALPHA   beta", mode: "literal", filter: { branchIds: ["main"] } });
  assert.equal(literal.hits.length, 1); assert.equal(literal.hits[0]?.trace.commitDigest, one.commitDigest);
  assert.equal(literal.hits[0]?.trace.entryDigest, one.object.effectiveEntryDigests[0]); assert.equal(literal.hits[0]?.trace.exactBody, true);
  assert.equal(query.query({ query: "b.ta", mode: "regex", regexFlags: "iu" }).hits.length, 3);
  const ranked = query.query({ query: "alpha beta", mode: "full-text" });
  assert.equal(ranked.hits[0]?.text, "beta beta alpha");
  assert.deepEqual(query.query({ query: "alpha beta", mode: "full-text" }).hits, ranked.hits);
});

test("cursor holds a stable checkpoint cut across later publications and restart", async () => {
  const f = await fixture(); await f.publish([{ text: "match one" }, { text: "match two" }], "main");
  let query = new DurableContextQuery({ root: f.root, sessionId: "only-this", primeSessionFile: f.session });
  const first = query.query({ query: "match", limit: 1 }); assert.ok(first.nextCursor); assert.equal(first.snapshotGeneration, 1);
  await f.publish([{ text: "match newest" }], "other");
  query = new DurableContextQuery({ root: f.root, sessionId: "only-this", primeSessionFile: f.session });
  const second = query.query({ query: "match", limit: 1, cursor: first.nextCursor });
  assert.equal(second.snapshotGeneration, 1); assert.equal(second.hits[0]?.text, "match two");
  assert.throws(() => query.query({ query: "different", cursor: first.nextCursor }), /does not match/);
});

test("branch and generation filters span checkpoints without cross-session leakage", async () => {
  const f = await fixture(); await f.publish([{ text: "needle main" }], "main"); await f.publish([{ text: "needle fork" }], "fork");
  const query = new DurableContextQuery({ root: f.root, sessionId: "only-this", primeSessionFile: f.session });
  assert.deepEqual(query.query({ query: "needle", filter: { branchIds: ["main"] } }).hits.map(h => h.text), ["needle main"]);
  assert.deepEqual(query.listCheckpoints({ generations: { min: 2 } }).map(c => c.branchId), ["fork"]);
  assert.throws(() => new DurableContextQuery({ root: f.root, sessionId: "another", primeSessionFile: f.session }), /another Prime session/);
  const other = join(f.temporary, "other.jsonl"); await writeFile(other, "", "utf8");
  assert.throws(() => new DurableContextQuery({ root: f.root, sessionId: "only-this", primeSessionFile: other }), /another Prime session/);
});

test("corrupt checkpoints are isolated and all query bounds are enforced", async () => {
  const f = await fixture(); const old = await f.publish([{ text: "safe match" }], "main"); const bad = await f.publish([{ text: "bad match" }], "main");
  await writeFile(join(f.root, "objects", `${bad.commit.object}.json`), "corrupt", "utf8");
  const query = new DurableContextQuery({ root: f.root, sessionId: "only-this", primeSessionFile: f.session, maxResults: 2, maxQueryBytes: 8, maxScannedEntries: 2 });
  const page = query.query({ query: "match" }); assert.equal(page.skippedCorruptCheckpoints, 1); assert.equal(page.hits[0]?.trace.commitDigest, old.commitDigest);
  assert.throws(() => query.query({ query: "123456789" }), /bound/); assert.throws(() => query.query({ query: "x", limit: 3 }), /bound/);
  assert.throws(() => query.query({ query: "(", mode: "regex" }), /regular expression/);
  await f.publish([{ text: "a" }, { text: "b" }, { text: "c" }], "main");
  assert.throws(() => query.query({ query: "a" }), /scan exceeds/);
});

test("v2 source search resolves exact immutable bodies", async () => {
  const f = await fixture(); await f.publish([{ text: "source needle" }], "main");
  const query = new DurableContextQuery({ root: f.root, sessionId: "only-this", primeSessionFile: f.session });
  const hit = query.query({ query: "needle", scope: "source" }).hits[0];
  assert.deepEqual(hit?.value, { text: "source needle" }); assert.equal(hit?.trace.scope, "source"); assert.equal(hit?.trace.exactBody, true);
});


test("cursor binds immutable head and commit identity, not only a generation number",async()=>{
 const f=await fixture();const published=await f.publish([{text:"match one"},{text:"match two"}],"main");const query=new DurableContextQuery({root:f.root,sessionId:"only-this",primeSessionFile:f.session});const page=query.query({query:"match",limit:1});assert.ok(page.nextCursor);
 await writeFile(join(f.root,"heads",`${String(published.commit.generation).padStart(16,"0")}-${published.commitDigest}`),"0".repeat(64)+"\n");assert.throws(()=>query.query({query:"match",limit:1,cursor:page.nextCursor}),/snapshot is no longer available/);
});
