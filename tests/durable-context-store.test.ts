import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableContextStore, type FaultBoundary } from "../src/durable-context-store.js";

async function fixture(options: Partial<ConstructorParameters<typeof DurableContextStore>[0]> = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "durable-context-"));
  const session = join(temporary, "prime.jsonl"); await writeFile(session, "", "utf8");
  const root = join(temporary, "store");
  const store = new DurableContextStore({ root, binding: { sessionId: "session-a", primeSessionFile: session }, ...options });
  return { temporary, session, root, store };
}
const input = (source: unknown[], effective = source, observedAt = 1) => ({ source, effective, observedAt, converterVersion: "converter-1", schemaVersion: "schema-1", branchId: "leaf" });

test("publishes immutable generations, proves append prefixes, and replays as a no-op", async () => {
  const { store } = await fixture();
  const first = await store.publish(input([{ text: "one" }]));
  assert.equal(first.mode, "rebuild"); assert.equal(first.commit.generation, 1);
  const replay = await store.publish(input([{ text: "one" }], [{ text: "one" }], 999));
  assert.equal(replay.mode, "noop"); assert.equal(replay.commitDigest, first.commitDigest);
  const append = await store.publish(input([{ text: "one" }, { text: "two" }]));
  assert.equal(append.mode, "append"); assert.equal(append.commit.parent, first.commitDigest); assert.equal(append.commit.commonPrefix, 1);
  const rewrite = await store.publish(input([{ text: "changed" }, { text: "two" }]));
  assert.equal(rewrite.mode, "rebuild"); assert.equal(rewrite.commit.commonPrefix, 0);
});

test("every publication crash boundary retains a readable valid generation", async (t) => {
  const boundaries: FaultBoundary[] = ["object-durable", "commit-durable", "head-durable", "current-temp-durable", "current-replaced"];
  for (const boundary of boundaries) await t.test(boundary, async () => {
    const f = await fixture(); const old = await f.store.publish(input([{ text: "old" }]));
    const crashing = new DurableContextStore({ root: f.root, binding: { sessionId: "session-a", primeSessionFile: f.session }, fault: (at) => { if (at === boundary) throw new Error(`crash:${at}`); } });
    await assert.rejects(crashing.publish(input([{ text: "old" }, { text: "new" }])), /crash/);
    const recovered = new DurableContextStore({ root: f.root, binding: { sessionId: "session-a", primeSessionFile: f.session } }).recover();
    assert.ok(recovered); assert.ok(recovered.commit.generation >= 1);
    const oldCommit = await readFile(join(f.root, "commits", `${old.commitDigest}.json`), "utf8");
    assert.match(oldCommit, /derived-commit-v1/);
    if (boundary === "object-durable" || boundary === "commit-durable") assert.equal(recovered.commitDigest, old.commitDigest);
    else assert.equal(recovered.commit.generation, 2);
  });
});

test("recovery ignores corrupt CURRENT and corrupt newest content", async () => {
  const { root, store } = await fixture();
  const old = await store.publish(input(["old"])); const latest = await store.publish(input(["old", "new"]));
  await writeFile(join(root, "CURRENT"), "../../escape\n", "utf8");
  assert.equal(store.recover()?.commitDigest, latest.commitDigest);
  await chmod(join(root, "objects", `${latest.commit.object}.json`), 0o600);
  await writeFile(join(root, "objects", `${latest.commit.object}.json`), "corrupt", "utf8");
  assert.equal(store.recover()?.commitDigest, old.commitDigest);
});

test("concurrent publishers serialize and recover the newest complete commit", async () => {
  const f = await fixture();
  const stores = Array.from({ length: 8 }, () => new DurableContextStore({ root: f.root, binding: { sessionId: "session-a", primeSessionFile: f.session } }));
  const results = await Promise.all(stores.map((store, index) => store.publish(input(Array.from({ length: index + 1 }, (_, n) => ({ n })), undefined, index))));
  const generations = results.map((result) => result.commit.generation).sort((a, b) => a - b);
  assert.deepEqual(generations, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(stores[0]?.recover()?.commit.generation, 8);
});



test("atomic directory lock excludes independent processes", async () => {
  const f = await fixture();
  const moduleUrl = pathToFileURL(join(process.cwd(), "src", "durable-context-store.ts")).href;
  const run = promisify(execFile);
  const launches = Array.from({ length: 4 }, (_, index) => {
    const code = `import { DurableContextStore } from ${JSON.stringify(moduleUrl)};
const store = new DurableContextStore({root:${JSON.stringify(f.root)},binding:{sessionId:"session-a",primeSessionFile:${JSON.stringify(f.session)}}});
const result = await store.publish({source:[{process:${index}}],effective:[{process:${index}}],converterVersion:"converter-1",schemaVersion:"schema-1",observedAt:${index}});
console.log(result.commit.generation);`;
    return run(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code]);
  });
  const completed = await Promise.all(launches);
  const generations = completed.map(({ stdout }) => Number(stdout.trim())).sort((a, b) => a - b);
  assert.deepEqual(generations, [1, 2, 3, 4]);
  assert.equal(f.store.recover()?.commit.generation, 4);
});

test("compatibility view is bounded and UTF-8 crops long entries", async () => {
  const { store } = await fixture({ maxEntries: 2, maxEntryBytes: 80 });
  const result = await store.publish(input([{ text: "discarded" }, { text: "🙂".repeat(100) }, { content: "short" }], [{ role: "user", content: "effective" }]));
  const view = result.object.compatibility;
  assert.equal(view.entries.length, 2); assert.equal(view.entries[0]?.index, 1); assert.equal(view.entries[0]?.truncated, true);
  assert.match(view.entries[0]?.text ?? "", /UTF-8 bytes omitted/); assert.equal(view.messages, undefined); assert.equal(view.cropped, true);
  assert.equal(view.sourceDigest, result.commit.sourceDigest); assert.equal(view.effectiveDigest, result.commit.effectiveDigest);
});

test("canonical binding rejects reuse and symlink store roots", async () => {
  const f = await fixture();
  const other = join(f.temporary, "other.jsonl"); await writeFile(other, "", "utf8");
  assert.throws(() => new DurableContextStore({ root: f.root, binding: { sessionId: "session-a", primeSessionFile: other } }), /bound to another/);
  const target = join(f.temporary, "target"); await mkdir(target); const link = join(f.temporary, "link"); await symlink(target, link);
  const canonicalized = new DurableContextStore({ root: join(link, "store"), binding: { sessionId: "session-b", primeSessionFile: other } });
  assert.equal(canonicalized.root, await realpath(join(target, "store")));
  assert.throws(() => new DurableContextStore({ root: "relative", binding: { sessionId: "session-b", primeSessionFile: other } }), /absolute/);
});


test("rejects a symlink introduced inside the managed store", async () => {
  const f = await fixture();
  const outside = join(f.temporary, "outside"); await mkdir(outside);
  await rm(join(f.root, "objects"), { recursive: true });
  await symlink(outside, join(f.root, "objects"));
  await assert.rejects(f.store.publish(input(["must-not-escape"])), /unsafe durable store directory/);
  assert.deepEqual(await (await import("node:fs/promises")).readdir(outside), []);
});


test("leaf divergence is a rebuild and never reuses stale compatibility metadata", async () => {
  const { store } = await fixture();
  const first = await store.publish({ ...input(["same"]), branchId: "leaf-a" });
  const second = await store.publish({ ...input(["same"]), branchId: "leaf-b" });
  assert.equal(first.object.compatibility.branchId, "leaf-a");
  assert.equal(second.mode, "rebuild");
  assert.equal(second.object.compatibility.branchId, "leaf-b");
  assert.equal(second.commit.generation, 2);
});

test("more than 2000 compatibility entries are bounded while an oversized effective body publishes", async () => {
  const { store } = await fixture({ maxObjectBytes: 1_000_000 });
  const many = Array.from({ length: 2_101 }, (_, index) => ({ text: `entry-${index}` }));
  const published = await store.publish(input(many, [{ role: "user", content: "bounded" }]));
  assert.equal(published.object.compatibility.entries.length, 2_000);
  assert.equal(published.object.compatibility.entries[0]?.index, 101);
  const large = await store.publish(input(many, [{ role: "user", content: "x".repeat(2_000_000) }]));
  assert.equal(store.recover()?.commitDigest, large.commitDigest);
  assert.equal(large.object.effective, undefined);
});


test("real subprocess SIGKILL at each publication boundary recovers an all-or-none generation", async (t) => {
 const boundaries: FaultBoundary[]=["object-durable","commit-durable","head-durable","current-temp-durable","current-replaced"];
 for (const boundary of boundaries) await t.test(boundary,async()=>{
  const f=await fixture();const old=await f.store.publish(input([{text:"old"}]));const moduleUrl=pathToFileURL(join(process.cwd(),"src","durable-context-store.ts")).href;
  const code=`import {DurableContextStore} from ${JSON.stringify(moduleUrl)};const s=new DurableContextStore({root:${JSON.stringify(f.root)},binding:{sessionId:"session-a",primeSessionFile:${JSON.stringify(f.session)}},fault:(b)=>{if(b===${JSON.stringify(boundary)})process.kill(process.pid,"SIGKILL")}});await s.publish(${JSON.stringify(input([{text:"old"},{text:"new"}]))});`;
  const child=spawn(process.execPath,["--import","tsx","--input-type=module","--eval",code],{stdio:"ignore"});const [exitCode,signal]=await once(child,"exit");assert.equal(exitCode,null);assert.equal(signal,"SIGKILL");
  const recovered=new DurableContextStore({root:f.root,binding:{sessionId:"session-a",primeSessionFile:f.session}}).recover();assert.ok(recovered);assert.ok(recovered.commitDigest===old.commitDigest||recovered.commit.generation===2);
 });
});

test("a SIGKILL-stale subprocess lock is safely reclaimed", async()=>{
 const f=await fixture();const moduleUrl=pathToFileURL(join(process.cwd(),"src","durable-context-store.ts")).href;
 const code=`import {DurableContextStore} from ${JSON.stringify(moduleUrl)};import{mkdirSync,writeFileSync}from"node:fs";const s=new DurableContextStore({root:${JSON.stringify(f.root)},binding:{sessionId:"session-a",primeSessionFile:${JSON.stringify(f.session)}}});mkdirSync(${JSON.stringify(join(f.root,"LOCK"))});writeFileSync(${JSON.stringify(join(f.root,"LOCK","owner.json"))},JSON.stringify({pid:process.pid,started:Date.now()}));process.kill(process.pid,"SIGKILL");`;
 const child=spawn(process.execPath,["--import","tsx","--input-type=module","--eval",code],{stdio:"ignore"});const [,signal]=await once(child,"exit");assert.equal(signal,"SIGKILL");await utimes(join(f.root,"LOCK"),new Date(0),new Date(0));
 const store=new DurableContextStore({root:f.root,binding:{sessionId:"session-a",primeSessionFile:f.session},staleLockMs:1,lockTimeoutMs:2000});assert.equal((await store.publish(input(["recovered"]))).commit.generation,1);
});

test("recovery crosses more than 128 poison heads and generation identities never rewind", async()=>{
 const f=await fixture({recoveryScanLimit:128});const valid=await f.store.publish(input(["valid"]));
 for(let n=2;n<142;n++){const digest=n.toString(16).padStart(64,"0");await writeFile(join(f.root,"heads",`${String(n).padStart(16,"0")}-${digest}`),`${"f".repeat(64)}\n`);}
 assert.equal(f.store.recover()?.commitDigest,valid.commitDigest);const next=await f.store.publish(input(["valid","next"]));assert.equal(next.commit.generation,142);assert.notEqual(next.commitDigest,valid.commitDigest);
});

test("fork heads choose their longest valid branch ancestor rather than globally newest commit",async()=>{
 const f=await fixture();const root=await f.store.publish(input(["root"],undefined,1));const left=await f.store.publish({...input(["root","left"],undefined,2),branchId:"left"});const right=await f.store.publish({...input(["root","right"],undefined,3),branchId:"right"});const left2=await f.store.publish({...input(["root","left","left2"],undefined,4),branchId:"left2"});
 assert.equal(left.commit.parent,root.commitDigest);assert.equal(right.commit.parent,root.commitDigest);assert.equal(left2.commit.parent,left.commitDigest);
});


test("durable publication rejects lone surrogates without replacing the prior valid generation",async()=>{
 const f=await fixture();const old=await f.store.publish(input(["valid"]));await assert.rejects(f.store.publish(input(["bad\ud800text"])),/well-formed Unicode/);assert.equal(f.store.recover()?.commitDigest,old.commitDigest);
});


test("v2 publishes and recovers cumulative effective context larger than 16 MiB without a monolithic object", async () => {
  const { root, store } = await fixture();
  const effective = Array.from({ length: 17 }, (_, index) => ({ role: "user", content: `${index}:` + "x".repeat(1024 * 1024) }));
  const result = await store.publish(input(effective));
  const objectRaw = await readFile(join(root, "objects", `${result.commit.object}.json`));
  assert.equal(result.object.version, "prime-agent-dsh/derived-object-v2");
  assert.ok(objectRaw.byteLength < 16 * 1024 * 1024);
  assert.equal(result.object.compatibility.messages, undefined);
  assert.equal(store.recover()?.commitDigest, result.commitDigest);
});

test("v2 recovery fails closed on a missing or tampered entry body", async () => {
  const { root, store } = await fixture();
  const old = await store.publish(input([{ text: "old" }]));
  const latest = await store.publish(input([{ text: "old" }, { text: "latest" }]));
  const body = latest.object.effectiveEntryDigests[1]; assert.ok(body);
  await writeFile(join(root, "bodies", `${body}.json`), '{"text":"tampered"}\n');
  assert.equal(store.recover()?.commitDigest, old.commitDigest);
});
