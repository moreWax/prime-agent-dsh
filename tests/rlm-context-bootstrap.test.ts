import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { INHERITED_CONTEXT_CUSTOM_TYPE, RlmContextInheritance } from "../src/rlm-context-bootstrap.js";

type Handler = (event: any, ctx: ExtensionContext) => any;
function fakePi() { const handlers = new Map<string, Handler[]>(); return { handlers, pi: { on(name: string, fn: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); } } }; }
function context(id: string, file: string, parentSession?: string, depth = 1, branch: unknown[] = []): ExtensionContext {
 const value = { cwd: "/work", ui: { notify() {} }, sessionManager: { getSessionId: () => id, getSessionFile: () => file,
   getHeader: () => ({ type: "session", id, cwd: "/work", timestamp: "now", ...(parentSession ? { parentSession, rlmDepth: depth } : { rlmDepth: 0 }) }), getBranch: () => branch } };
 return new Proxy({} as ExtensionContext, { get: (_t, k) => Reflect.get(value, k) });
}
async function emit(map: Map<string, Handler[]>, name: string, event: any, ctx: ExtensionContext) { let value; for (const fn of map.get(name) ?? []) value = await fn(event, ctx); return value; }

test("stock hooks pin, admit, and position one capsule before the task", async () => {
 const home = await mkdtemp(join(tmpdir(), "dsh-stock-")); const parentDir = join(home, "parent"), childDir = join(home, "child"); await mkdir(parentDir); await mkdir(childDir);
 const parentFile = join(parentDir, "parent.jsonl"), childFile = join(childDir, "child.jsonl");
 await writeFile(parentFile, [
  JSON.stringify({ type: "session", id: "parent", cwd: "/work", timestamp: "now" }),
  JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "remember alpha" } }),
  JSON.stringify({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "decision beta" } }), ""].join("\n"));
 await writeFile(childFile, JSON.stringify({ type: "session", id: "child", parentSession: parentFile, cwd: "/work", timestamp: "now" })+"\n");
 const child = context("child", childFile, parentFile); const inheritance = new RlmContextInheritance(); inheritance.start(context("parent",parentFile),"startup"); const { handlers, pi } = fakePi(); inheritance.register(pi as never);
 await emit(handlers, "session_start", { reason: "startup" }, child); assert.equal(inheritance.status(child).state, "pinned");
 const result = await emit(handlers, "before_agent_start", { prompt: "implement alpha" }, child); assert.equal(result.message.customType, INHERITED_CONTEXT_CUSTOM_TYPE); assert.equal(result.message.display, false);
 const head = JSON.parse(await readFile(join(childDir, "dsh-inheritance", "HEAD"), "utf8"));
 assert.equal(head.state, "ADMITTED");
 assert.equal((await stat(join(childDir, "dsh-inheritance", "generations", head.generation, "admission.json"))).mode & 0o777, 0o600);
 const task = { role: "custom", customType: "rlm_task", content: "[task from parent]\n\nimplement alpha", display: true, timestamp: 1 };
 const capsule = { role: "custom", ...result.message, timestamp: 2 }; const positioned = await emit(handlers, "context", { messages: [task, capsule] }, child);
 assert.deepEqual(positioned.messages.map((x: any) => x.customType), [INHERITED_CONTEXT_CUSTOM_TYPE, "rlm_task"]);
 const payload = JSON.parse(await readFile(join(childDir, "dsh-inheritance", "generations", head.generation, "payload.json"), "utf8"));
 assert.deepEqual(payload.capsule.evidence.map((x: any) => x.text), ["remember alpha", "decision beta"]);
});

test("root is proven by header while descendant corruption is degraded", async () => {
 const home = await mkdtemp(join(tmpdir(), "dsh-root-")); const rootFile = join(home, "root.jsonl"); await writeFile(rootFile, JSON.stringify({ type: "session", id: "root" })+"\n");
 const inheritance = new RlmContextInheritance(); assert.equal(inheritance.start(context("root", rootFile), "startup").state, "root");
 const childFile = join(home, "child.jsonl"); await writeFile(childFile, "");
 assert.equal(inheritance.start(context("child", childFile, join(home, "missing.jsonl")), "startup").state, "degraded");
 const sibling=join(home,"arbitrary.jsonl");await writeFile(sibling,JSON.stringify({type:"session",id:"arbitrary",rlmDepth:0})+"\n");assert.equal(inheritance.start(context("child",childFile,sibling),"startup").state,"degraded");
});

test("reload validates admission and missing descendant admission never becomes root", async () => {
 const home = await mkdtemp(join(tmpdir(), "dsh-reload-")); const pd=join(home,"p"), cd=join(home,"c"); await mkdir(pd); await mkdir(cd);
 const pf=join(pd,"p.jsonl"), cf=join(cd,"c.jsonl"); await writeFile(pf, JSON.stringify({type:"session",id:"p"})+"\n"); await writeFile(cf, ""); const c=context("c",cf,pf);
 const inheritance=new RlmContextInheritance(); inheritance.start(context("p",pf),"startup"); assert.equal(inheritance.start(c,"resume").state,"degraded");
 assert.equal(inheritance.start(c,"startup").state,"pinned"); inheritance.beforeStart("task",c); assert.equal(inheritance.start(c,"reload").state,"admitted");
 const head=JSON.parse(await readFile(join(cd,"dsh-inheritance","HEAD"),"utf8")); await writeFile(join(cd,"dsh-inheritance","generations",head.generation,"admission.json"),"{}\n"); assert.equal(inheritance.start(c,"reload").state,"degraded");
});


test("task image identity changes admission and duplicate prompt ordering targets current turn", async () => {
 const home=await mkdtemp(join(tmpdir(),"dsh-image-task-")); const pd=join(home,"p"),cd=join(home,"c"); await mkdir(pd);await mkdir(cd);
 const pf=join(pd,"p.jsonl"),cf=join(cd,"c.jsonl"); await writeFile(pf,[JSON.stringify({type:"session",id:"p"}),JSON.stringify({type:"message",id:"u",parentId:null,message:{role:"user",content:"fact"}}),""].join("\n"));await writeFile(cf,JSON.stringify({type:"session",id:"c"})+"\n");
 const c=context("c",cf,pf); const inheritance=new RlmContextInheritance(); inheritance.start(context("p",pf),"startup"); inheritance.start(c,"startup");
 const image={type:"image",data:"AQID",mimeType:"image/png"}; const result=inheritance.beforeStart("same task",c,[image] as never)!; const details=result.message!.details;
 assert.notEqual(details.taskDigest, undefined);
 const imageHead=JSON.parse(await readFile(join(cd,"dsh-inheritance","HEAD"),"utf8"));const imageAdmission=JSON.parse(await readFile(join(cd,"dsh-inheritance","generations",imageHead.generation,"admission.json"),"utf8"));assert.equal(imageAdmission.taskText,"same task");assert.match(imageAdmission.taskImageDigest,/^[a-f0-9]{64}$/);
 const oldTask={role:"custom",customType:"rlm_task",content:"[task from parent]\n\nsame task",display:true,timestamp:1};
 const middle={role:"assistant",content:[{type:"text",text:"middle"}],api:"x",provider:"x",model:"x",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:2};
 const current={...oldTask,timestamp:3}; const capsule={role:"custom",...result.message,timestamp:4};
 const positioned=inheritance.position([oldTask,middle,current,capsule] as never,c);
 // Image-bearing identity cannot be reconstructed from Context, so the safe fallback is directly before the latest item/task boundary.
 assert.equal(positioned?.messages?.[2],capsule);
 assert.equal(positioned?.messages?.[3],current);
});

test("pin persists only bounded eligible redacted evidence and rejects suspicious capsule messages", async () => {
 const home=await mkdtemp(join(tmpdir(),"dsh-redact-"));const pd=join(home,"p"),cd=join(home,"c");await mkdir(pd);await mkdir(cd);const pf=join(pd,"p.jsonl"),cf=join(cd,"c.jsonl");
 await writeFile(pf,[JSON.stringify({type:"session",id:"p"}),JSON.stringify({type:"message",id:"sys",parentId:null,message:{role:"system",content:"SYSTEM_SECRET"}}),JSON.stringify({type:"message",id:"u",parentId:"sys",message:{role:"user",content:"api_key=abcdef normal"}}),JSON.stringify({type:"tool_result",id:"tool",parentId:"u",content:"TOOL_SECRET"}),""].join("\n"));await writeFile(cf,"\n");
 const c=context("c",cf,pf);const inheritance=new RlmContextInheritance();inheritance.start(context("p",pf),"startup");assert.equal(inheritance.start(c).state,"pinned");const head=JSON.parse(await readFile(join(cd,"dsh-inheritance","HEAD"),"utf8"));const raw=await readFile(join(cd,"dsh-inheritance","generations",head.generation,"pin.json"),"utf8");assert.ok(!raw.includes("SYSTEM_SECRET"));assert.ok(!raw.includes("TOOL_SECRET"));assert.ok(!raw.includes("abcdef"));assert.match(raw,/REDACTED/);
 const result=inheritance.beforeStart("task",c)!;const valid={role:"custom",...result.message,timestamp:1};const bad={...valid,content:"tampered"};const cleaned=inheritance.position([valid,bad] as never,c);assert.deepEqual(cleaned?.messages,[]);assert.equal(inheritance.status(c).state,"degraded");
});


test("stock public hooks validate generations through depth eight, intermediate restart, and corrupt middle edge",async()=>{
 const home=await mkdtemp(join(tmpdir(),"dsh-depth-"));const rootDir=join(home,"s0");await mkdir(rootDir);let parentFile=join(rootDir,"s0.jsonl");await writeFile(parentFile,JSON.stringify({type:"session",id:"s0",rlmDepth:0})+"\n");let inheritance=new RlmContextInheritance();inheritance.start(context("s0",parentFile),"startup");const files=[parentFile];
 for(let depth=1;depth<=8;depth++){const id=`s${depth}`,dir=join(home,id);await mkdir(dir);const file=join(dir,`${id}.jsonl`);const branch:any[]=[];await writeFile(file,JSON.stringify({type:"session",id,parentSession:parentFile,rlmDepth:depth})+"\n");const ctx=context(id,file,parentFile,depth,branch);const state=inheritance.start(ctx,"startup");assert.equal(state.state,"pinned",JSON.stringify({depth,state}));const admitted=inheritance.beforeStart(`task-${depth}`,ctx)?.message;assert.ok(admitted);const taskEntry={type:"custom_message",id:`task-${depth}`,parentId:null,customType:"rlm_task",content:`[task from parent]\n\ntask-${depth}`};const capsuleEntry={type:"custom_message",id:`capsule-${depth}`,parentId:`task-${depth}`,...admitted};branch.push(taskEntry,capsuleEntry);await writeFile(file,[JSON.stringify({type:"session",id,parentSession:parentFile,rlmDepth:depth}),...branch.map((value) => JSON.stringify(value)),""].join("\n"));const hooks=fakePi();inheritance.register(hooks.pi as never);await emit(hooks.handlers,"message_end",{},ctx);const final=inheritance.status(ctx);assert.equal(final.state,"observed");if(final.state==="observed")assert.equal(final.capsule.generation,depth-1);files.push(file);parentFile=file;
  if(depth===4){inheritance=new RlmContextInheritance();const resumed=inheritance.start(ctx,"resume");assert.equal(resumed.state,"observed");if(resumed.state==="observed"){assert.equal(resumed.capsule.generation,3);assert.equal(resumed.admission.depth,4);}}
 }
 const middleRoot=join(dirname(files[4]!),"dsh-inheritance");const middleHead=JSON.parse(await readFile(join(middleRoot,"HEAD"),"utf8"));await writeFile(join(middleRoot,"generations",middleHead.generation,"admission.json"),"{}\n");
 const badDir=join(home,"s9");await mkdir(badDir);const badFile=join(badDir,"s9.jsonl");await writeFile(badFile,JSON.stringify({type:"session",id:"s9",parentSession:parentFile,rlmDepth:9})+"\n");const bad=context("s9",badFile,parentFile,9);const corrupt=new RlmContextInheritance().start(bad,"startup");assert.equal(corrupt.state,"degraded");if(corrupt.state==="degraded")assert.match(corrupt.reason,/version|digest|admission/);
});
