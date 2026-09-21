import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ContextObjectStore, contextObjectRoot } from "../src/context-objects.js";
import { DurableContextQuery } from "../src/durable-context-query.js";

function primeContext(sessionId: string, sessionFile: string, branch: unknown[], leaf: () => string): ExtensionContext {
  const value = {
    cwd: "/workspace",
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
      getLeafId: leaf,
      getBranch: () => branch,
    },
  };
  return new Proxy({} as ExtensionContext, { get: (_target, key) => Reflect.get(value, key) });
}

test("context objects mirror Prime without changing its messages", async () => {
  const home = await mkdtemp(join(tmpdir(), "prime-dsh-context-"));
  const sessions = join(home, "sessions");
  await mkdir(sessions);
  const sessionId = "session-a";
  const sessionFile = join(sessions, `${sessionId}.jsonl`);
  await writeFile(sessionFile, "", "utf8");
  let leaf = "assistant-1";
  const branch: unknown[] = [
    { type: "message", id: "user-1", parentId: null, message: { role: "user", content: "alpha" } },
    { type: "message", id: "assistant-1", parentId: "user-1", message: {
      role: "assistant", content: [{ type: "text", text: "beta" }], provider: "p", model: "m",
      usage: { input: 10, output: 2, cacheRead: 7, cacheWrite: 3, totalTokens: 12 },
    } },
  ];
  await writeFile(sessionFile, branch.map(value => JSON.stringify(value)).join("\n") + "\n");
  const ctx = primeContext(sessionId, sessionFile, branch, () => leaf);
  const messages: unknown[] = branch.map((entry) => (entry as { message: unknown }).message);
  const store = new ContextObjectStore();

  const first = await store.sync(ctx, messages);
  assert(first);
  assert.equal(first.manifest.syncMode, "rebuild");
  assert.equal(first.manifest.revision, 1);
  assert.equal(first.manifest.metrics.cacheReadTokens, 7);
  assert.equal(first.root, join(home, "session-artifacts", sessionId, "dsh-context"));
  assert.equal(contextObjectRoot(sessionId, sessionFile), first.root);
  assert.equal((await stat(join(first.root, "manifest.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(first.root)).mode & 0o777, 0o700);

  const unchanged = await store.sync(ctx, messages);
  assert(unchanged);
  assert.equal(unchanged.manifest.syncMode, "noop");
  assert.equal(unchanged.manifest.revision, 1);
  assert.equal(unchanged.manifest.digest, first.manifest.digest);

  leaf = "user-2";
  branch.push({ type: "message", id: leaf, parentId: "assistant-1", message: { role: "user", content: "gamma" } });
  await writeFile(sessionFile, branch.map(value => JSON.stringify(value)).join("\n") + "\n");
  messages.push((branch.at(-1) as { message: unknown }).message);
  const appended = await store.sync(ctx, messages);
  assert(appended);
  assert.equal(appended.manifest.syncMode, "append");
  assert.equal(appended.manifest.revision, 2);
  assert.equal(appended.manifest.commonPrefixMessages, 2);
  assert.equal(appended.manifest.branchId, leaf);

  const stored = JSON.parse(await readFile(join(appended.root, appended.manifest.snapshot), "utf8"));
  assert.equal(stored.version, "prime-agent-dsh/derived-object-v3-reference");
  const snapshot = stored.compatibility;
  assert.equal(snapshot.version, "prime-agent-dsh/durable-store-v3-reference");
  assert.equal(snapshot.messages, undefined);
  assert.equal(stored.effective, undefined);
  assert.equal(stored.effectiveEntryDigests.length, 3);
  assert.deepEqual(stored.sourceLocators.map((entry: { entryId?: string }) => entry.entryId), ["user-1", "assistant-1", "user-2"]);
  assert.deepEqual(stored.effectiveReferences.map((entry: { sourceIndex: number | null }) => entry.sourceIndex), [0, 1, 2]);
  assert.deepEqual(snapshot.entries, []);
});


test("context sync sanitizes runtime-only child task and tool result metadata", async () => {
  const home = await mkdtemp(join(tmpdir(), "prime-dsh-context-runtime-"));
  const sessions = join(home, "sessions");
  await mkdir(sessions);
  const sessionId = "runtime-details";
  const sessionFile = join(sessions, `${sessionId}.jsonl`);
  await writeFile(sessionFile, "", "utf8");
  const branch: unknown[] = [];
  const ctx = primeContext(sessionId, sessionFile, branch, () => "tool-result-1");
  const taskDetails = { delivery: "child", signal: new AbortController().signal, callback: () => "runtime", missing: undefined };
  const resultDetails = { exitCode: 0, startedAt: new Date(0), handles: new Set(["runtime"]), bytes: 12n };
  const messages: unknown[] = [
    { role: "custom", customType: "agent_message", content: "[task from parent] keep this task text", display: false, details: taskDetails },
    { role: "assistant", provider: "p", model: "m", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "printf useful" } }] },
    { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "useful tool output" }], details: resultDetails, isError: false },
  ];

  const synced = await new ContextObjectStore().sync(ctx, messages);
  assert(synced);
  const stored = JSON.parse(await readFile(join(synced.root, synced.manifest.snapshot), "utf8"));
  assert.equal(stored.version, "prime-agent-dsh/derived-object-v3-reference");
  assert.deepEqual(stored.sourceLocators, []);
  assert.ok(stored.effectiveReferences.every((reference: { sourceIndex: number | null }) => reference.sourceIndex === null));
  assert.equal((await (await import("node:fs/promises")).readdir(synced.root)).includes("bodies"), false);
  assert.equal(Object.isFrozen(taskDetails), false);
  assert.equal(Object.isFrozen(resultDetails), false);
});


test("restart repairs a corrupt compatibility manifest and Python reads the committed durable object", async () => {
  const home = await mkdtemp(join(tmpdir(), "prime-dsh-restart-"));
  const sessions = join(home, "sessions");
  await mkdir(sessions);
  const sessionId = "restart-session";
  const sessionFile = join(sessions, `${sessionId}.jsonl`);
  await writeFile(sessionFile, "", "utf8");
  const branch = [{ type: "message", id: "u1", parentId: null, message: { role: "user", content: "persist me" } }];
  await writeFile(sessionFile, branch.map(value => JSON.stringify(value)).join("\n") + "\n");
  const ctx = primeContext(sessionId, sessionFile, branch, () => "u1");
  const messages = [{ role: "user", content: "persist me" }];
  const first = await new ContextObjectStore().sync(ctx, messages);
  assert(first);
  await writeFile(join(first.root, "CURRENT"), "corrupt\n", "utf8");
  await writeFile(join(first.root, "manifest.json"), "{corrupt", "utf8");
  const restarted = await new ContextObjectStore().sync(ctx, messages);
  assert(restarted);
  assert.equal(restarted.manifest.revision, 1);
  assert.equal(restarted.manifest.syncMode, "noop");
  const run = promisify(execFile);
  const sessionDir = join(home, "session-artifacts", sessionId);
  const code = "import dsh_context; s=dsh_context.current().snapshot(); print(s.session_id, s.entries()[0].text)";
  const result = await run("python3", ["-c", code], { env: { ...process.env, RLM_SESSION_DIR: sessionDir, PYTHONPATH: join(process.cwd(), "skills/dsh-context/src") } });
  assert.equal(result.stdout.trim(), `${sessionId} persist me`);
});


test("real ContextObjectStore survives a greater-than-2000 message restart, query, and spill lifecycle",async()=>{
 const home=await mkdtemp(join(tmpdir(),"prime-dsh-large-"));const sessions=join(home,"sessions");await mkdir(sessions);const sessionId="large-session",sessionFile=join(sessions,`${sessionId}.jsonl`);await writeFile(sessionFile,"");
 const branch:unknown[]=[],messages:unknown[]=[];for(let i=0;i<2101;i++){const content=i===2100?`needle-${i}-`+"🙂".repeat(40000):`message-${i}`;branch.push({type:"message",id:`m-${i}`,parentId:i?`m-${i-1}`:null,message:{role:"user",content}});messages.push({role:"user",content,timestamp:i});}
 await writeFile(sessionFile,branch.map(value=>JSON.stringify(value)).join("\n")+"\n");
 const ctx=primeContext(sessionId,sessionFile,branch,()=>"m-2100");const first=await new ContextObjectStore().sync(ctx,messages);assert(first);assert.equal(first.manifest.messageCount,2101);assert.equal(first.manifest.cropped,false);
 const recovered=new ContextObjectStore().recover(ctx);assert.equal(recovered?.object.compatibility.messageCount,2101);
 const query=new DurableContextQuery({root:first.root,sessionId,primeSessionFile:sessionFile});const hits=query.query({query:"needle-2100",scope:"source",limit:2});assert.equal(hits.hits.length,1);assert.equal(hits.hits[0]?.trace.entryIndex,2100);
 assert.deepEqual(recovered?.object.compatibility.entries,[]);assert.equal((await (await import("node:fs/promises")).readdir(first.root)).includes("bodies"),false);
});
