import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, chmodSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { BeforeAgentStartEvent, ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildInheritanceCapsule, canonicalJsonDigest, renderInheritanceCapsule, validateCapsule,
  validateCapsuleLineage, type InheritanceCapsuleV1, type InheritanceSourceRecord,
} from "./rlm-context-inheritance.js";

export const INHERITED_CONTEXT_CUSTOM_TYPE = "prime-agent-dsh/inherited-context-v1" as const;
export const INHERITANCE_PAYLOAD_VERSION = "prime-agent-dsh/inheritance-payload-v3" as const;
export const ROOT_INHERITANCE_GENERATION = -1 as const;
export const INHERITANCE_ADMISSION_VERSION = "prime-agent-dsh/inheritance-admission-v3" as const;
const PIN_VERSION = "prime-agent-dsh/observed-parent-pin-v2" as const;
const HEAD_VERSION = "prime-agent-dsh/inheritance-head-v1" as const;
const SESSION_BINDING_VERSION = "prime-agent-dsh/session-binding-v1" as const;
const DIRECTORY = "dsh-inheritance";
const MAX_PARENT_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_PIN_RECORDS = 256;
const MAX_PIN_TEXT_BYTES = 512 * 1024;

type JsonObject = Record<string, unknown>;
type Header = { id?: string; parentSession?: string; rlmDepth?: number };
export interface ObservedParentPin {
  readonly version: typeof PIN_VERSION;
  readonly childSessionId: string; readonly childSessionFile: string;
  readonly parentSessionId: string; readonly parentSessionFile: string;
  readonly depth: number; readonly observedLeafId: string | null;
  readonly sourceBytes: number; readonly sourceDigest: string; readonly branchDigest: string;
  /** Only bounded, redacted, eligible records. Never the raw parent branch. */
  readonly records: readonly InheritanceSourceRecord[];
  readonly parentCapsule?: InheritanceCapsuleV1;
  readonly ancestorSessionIds: readonly string[];
}
export interface InheritancePayload { readonly version: typeof INHERITANCE_PAYLOAD_VERSION; readonly capsule: InheritanceCapsuleV1 }
export interface InheritanceAdmission {
  readonly version: typeof INHERITANCE_ADMISSION_VERSION;
  readonly childSessionId: string; readonly childSessionFile: string;
  readonly parentSessionId: string; readonly parentSessionFile: string;
  readonly depth: number; readonly observedLeafId: string | null;
  readonly pinDigest: string; readonly taskDigest: string; readonly taskText: string; readonly taskImageDigest: string; readonly payloadDigest: string;
  readonly contentDigest: string; readonly generation: string; readonly digest: string;
}
interface ArtifactHead { readonly version: typeof HEAD_VERSION; readonly state: "PINNED" | "ADMITTED" | "OBSERVED"; readonly generation: string; readonly digest: string }
export type InheritanceStatus =
  | { readonly state: "root" }
  | { readonly state: "pinned"; readonly pin: ObservedParentPin }
  | { readonly state: "admitted"; readonly capsule: InheritanceCapsuleV1; readonly admission: InheritanceAdmission }
  | { readonly state: "observed"; readonly capsule: InheritanceCapsuleV1; readonly admission: InheritanceAdmission }
  | { readonly state: "degraded" | "incompatible"; readonly reason: string };

type Runtime = { prompt?: string; taskDigest?: string; content?: string; admission?: InheritanceAdmission };
const object = (x: unknown): x is JsonObject => typeof x === "object" && x !== null && !Array.isArray(x);
const sha = (x: string | Buffer): string => createHash("sha256").update(x).digest("hex");
const safeId = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(x);
const lstatExists = (path: string): boolean => { try { lstatSync(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } };

function header(ctx: ExtensionContext): Header { const raw = ctx.sessionManager.getHeader?.(); return object(raw) ? raw : {}; }
function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe inheritance directory: ${path}`); chmodSync(path, 0o700);
}
function syncDirectory(path: string): void {
  try { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
  catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error; }
}
function writeExclusive(path: string, raw: string): void { const fd = openSync(path, "wx", 0o600); try { writeFileSync(fd, raw, "utf8"); fsyncSync(fd); } finally { closeSync(fd); } }
function atomicReplace(path: string, raw: string): void {
  ensureDirectory(dirname(path)); const temp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  try { writeExclusive(temp, raw); renameSync(temp, path); syncDirectory(dirname(path)); } catch (error) { rmSync(temp, { force: true }); throw error; }
}
function safeJson(path: string): JsonObject {
  const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARTIFACT_BYTES) throw new Error(`unsafe inheritance artifact: ${basename(path)}`);
  const value: unknown = JSON.parse(readFileSync(path, "utf8")); if (!object(value)) throw new Error(`invalid inheritance artifact: ${basename(path)}`); return value;
}
function rootFor(file: string): string { return join(dirname(file), DIRECTORY); }
function sessionBinding(file: string, id: string, h: Header): JsonObject {
  return { version: SESSION_BINDING_VERSION, sessionId: id, sessionFile: realpathSync(file), depth: Number.isSafeInteger(h.rlmDepth) ? h.rlmDepth : 0, parentSessionFile: h.parentSession ? realpathSync(resolve(dirname(realpathSync(file)), h.parentSession)) : null };
}
function ensureSessionBinding(file: string, id: string, h: Header): void {
  const root = rootFor(file); ensureDirectory(root); const path = join(root, "SESSION.json"); const expected = sessionBinding(file, id, h); const raw = `${JSON.stringify(expected)}\n`;
  if (lstatExists(path)) { const actual = safeJson(path); if (canonicalJsonDigest(actual) !== canonicalJsonDigest(expected)) throw new Error("DSH session binding mismatch"); }
  else atomicReplace(path, raw);
}
function validateParentSessionBinding(file: string, id: string, h: Header): void {
  const actual = safeJson(join(rootFor(file), "SESSION.json")); const expected = sessionBinding(file, id, h);
  if (canonicalJsonDigest(actual) !== canonicalJsonDigest(expected)) throw new Error("parent DSH session binding mismatch");
}
function publish(root: string, state: "PINNED" | "ADMITTED" | "OBSERVED", files: Readonly<Record<string, unknown>>, digest: string): string {
  ensureDirectory(root); const generations = join(root, "generations"); ensureDirectory(generations);
  const generation = `${state.toLowerCase()}-${digest}`; const target = join(generations, generation);
  if (!lstatExists(target)) {
    const stage = join(generations, `.${generation}.${randomBytes(8).toString("hex")}.tmp`); mkdirSync(stage, { mode: 0o700 });
    try { for (const [name, value] of Object.entries(files)) writeExclusive(join(stage, name), `${JSON.stringify(value)}\n`); syncDirectory(stage); renameSync(stage, target); syncDirectory(generations); }
    catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
  } else {
    const stat = lstatSync(target); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("inheritance generation collision is unsafe");
    for (const [name, value] of Object.entries(files)) {
      const expected = `${JSON.stringify(value)}\n`; const item = join(target, name); const itemStat = lstatSync(item);
      if (!itemStat.isFile() || itemStat.isSymbolicLink() || itemStat.size !== Buffer.byteLength(expected) || readFileSync(item, "utf8") !== expected) throw new Error("corrupt inheritance generation collision");
    }
  }
  const head: ArtifactHead = { version: HEAD_VERSION, state, generation, digest };
  atomicReplace(join(root, "HEAD"), `${JSON.stringify(head)}\n`); return generation;
}
function readHead(file: string): { head: ArtifactHead; dir: string } {
  const root = rootFor(file); const raw = safeJson(join(root, "HEAD")) as unknown as ArtifactHead;
  if (raw.version !== HEAD_VERSION || (raw.state !== "PINNED" && raw.state !== "ADMITTED" && raw.state !== "OBSERVED") || !/^[a-z]+-[a-f0-9]{64}$/.test(raw.generation) || !/^[a-f0-9]{64}$/.test(raw.digest)) throw new Error("invalid inheritance head");
  const dir = join(root, "generations", raw.generation); const rel = relative(root, dir); if (rel.startsWith(`..${sep}`) || rel === "..") throw new Error("unsafe inheritance head");
  const stat = lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe inheritance generation"); return { head: raw, dir };
}
function stableRead(path: string): Buffer {
  const real = realpathSync(path); if (real !== resolve(path) || extname(real) !== ".jsonl") throw new Error("parent session path is not a canonical JSONL file");
  for (let attempt = 0; attempt < 3; attempt++) { const fd = openSync(real, "r"); try { const before = fstatSync(fd); if (!before.isFile() || before.size > MAX_PARENT_BYTES) throw new Error("parent session file is unsafe or too large"); const data = readFileSync(fd); const after = fstatSync(fd); if (before.ino === after.ino && before.dev === after.dev && before.size === after.size && before.mtimeMs === after.mtimeMs && data.length === after.size) return data; } finally { closeSync(fd); } }
  throw new Error("parent session changed while it was pinned");
}
function activeBranch(entries: readonly unknown[]): readonly JsonObject[] {
  const nodes = entries.filter((x): x is JsonObject => object(x) && x.type !== "session" && typeof x.id === "string"); if (!nodes.length) return [];
  const byId = new Map(nodes.map(x => [x.id as string, x])); const output: JsonObject[] = []; const seen = new Set<string>(); let cursor: JsonObject | undefined = nodes.at(-1);
  while (cursor) { const id = cursor.id as string; if (seen.has(id)) throw new Error("parent session branch contains a cycle"); seen.add(id); output.push(cursor); const p = cursor.parentId; cursor = typeof p === "string" ? byId.get(p) : undefined; }
  return output.reverse();
}
function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(x => object(x) && x.type === "text" && typeof x.text === "string" ? [x.text] : []).join("\n");
}
function redact(value: string): string {
  let output = value;
  const replacements: Array<[RegExp, string]> = [
    [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu, "[REDACTED PRIVATE KEY]"],
    [/\bBasic\s+[A-Za-z0-9+/=]{8,}/giu, "Basic [REDACTED]"],
    [/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]"],
    [/\bAKIA[0-9A-Z]{16}\b/gu, "[REDACTED AWS ACCESS KEY]"],
    [/\b(AWS_SESSION_TOKEN|AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|DATABASE_URL|COOKIE|SET_COOKIE)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]"],
    [/(api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|secret|password|passwd|cookie)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]"],
    [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@"],
    [/\b(Cookie|Set-Cookie)\s*:\s*[^\r\n]+/giu, "$1: [REDACTED]"],
  ];
  for (const [pattern, replacement] of replacements) output = output.replace(pattern, replacement);
  // Treat long high-entropy assignment values as secrets even when the name is unknown.
  output = output.replace(/\b([A-Za-z_][A-Za-z0-9_.-]{1,64}\s*[:=]\s*)([A-Za-z0-9+/_=-]{32,})/gu,
    (_match, prefix: string, candidate: string) => new Set(candidate).size >= 12 ? `${prefix}[REDACTED]` : `${prefix}${candidate}`);
  return output;
}
function eligibleRecords(branch: readonly unknown[]): InheritanceSourceRecord[] {
  const output: InheritanceSourceRecord[] = []; let bytes = 0;
  for (let index = branch.length - 1; index >= 0 && output.length < MAX_PIN_RECORDS; index--) {
    const raw = branch[index]; if (!object(raw)) continue;
    let kind: "user" | "assistant" | "summary" | undefined; let value: string;
    if (raw.type === "message" && object(raw.message) && (raw.message.role === "user" || raw.message.role === "assistant")) { kind = raw.message.role; value = plainText(raw.message.content); }
    else if ((raw.type === "branch_summary" || raw.type === "compaction") && typeof raw.summary === "string") { kind = "summary"; value = raw.summary; }
    else continue;
    if (raw.customType === INHERITED_CONTEXT_CUSTOM_TYPE || !value) continue;
    const cleaned = redact(value); const size = Buffer.byteLength(cleaned); if (bytes + size > MAX_PIN_TEXT_BYTES) continue;
    bytes += size; output.push({ id: typeof raw.id === "string" ? raw.id : `entry-${index}`, kind, text: cleaned });
  }
  return output.reverse();
}
function rank(records: readonly InheritanceSourceRecord[], task: string): InheritanceSourceRecord[] {
  const query = new Set(task.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
  return records.map((x, index) => ({ ...x, priority: (index >= records.length - 2 ? 1000 : 0) + (x.text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(t => query.has(t)).length * 100 + index }));
}
function imageDigest(images: unknown): string { return canonicalJsonDigest(images ?? []); }
function taskDigest(prompt: string, images: unknown): string { return canonicalJsonDigest({ prompt, imageDigest: imageDigest(images) }); }
function customMessages(branch: readonly unknown[]): JsonObject[] { return branch.filter((raw): raw is JsonObject => object(raw) && raw.type === "custom_message" && raw.customType === INHERITED_CONTEXT_CUSTOM_TYPE); }

/** Stock Prime 0.9.5 public-hook inheritance. It does not claim spawn-transaction atomicity. */
export class RlmContextInheritance {
  private readonly statuses = new Map<string, InheritanceStatus>(); private readonly runtime = new Map<string, Runtime>();
  register(pi: Pick<ExtensionAPI, "on">): void {
    pi.on("session_start", async (event, ctx) => { await Promise.resolve(); this.start(ctx, event.reason); });
    pi.on("before_agent_start", (event, ctx) => this.beforeStart(event.prompt, ctx, event.images));
    pi.on("context", (event, ctx) => this.position(event.messages, ctx));
    pi.on("message_end", (_event, ctx) => { this.observe(ctx); });
    pi.on("agent_end", (_event, ctx) => { this.observe(ctx); });
    pi.on("session_shutdown", async (_event, ctx) => { await Promise.resolve(); if (ctx?.sessionManager) { const id = this.id(ctx); this.statuses.delete(id); this.runtime.delete(id); } else { this.statuses.clear(); this.runtime.clear(); } });
  }
  compatibility(): "best-effort-public-hooks" { return "best-effort-public-hooks"; }
  status(ctx: ExtensionContext): InheritanceStatus { return this.statuses.get(this.id(ctx)) ?? { state: "incompatible", reason: "session_start has not initialized DSH inheritance" }; }

  start(ctx: ExtensionContext, reason = "startup"): InheritanceStatus {
    const id = this.id(ctx); const file = ctx.sessionManager.getSessionFile?.(); const h = header(ctx);
    if (!file || !safeId(id)) return this.save(id, { state: "incompatible", reason: "persistent Prime session identity is unavailable" });
    const parent = h.parentSession; const headerDepth = Number.isSafeInteger(h.rlmDepth) ? h.rlmDepth : undefined;
    if (!parent && (headerDepth === 0 || headerDepth === undefined)) { try { ensureSessionBinding(file, id, { ...h, rlmDepth: 0 }); return this.save(id, { state: "root" }); } catch (error) { return this.degrade(ctx, error instanceof Error ? error.message : String(error)); } }
    if (!parent || headerDepth === undefined || headerDepth < 1) return this.degrade(ctx, "inconsistent Prime descendant header");
    try {
      const childFile = realpathSync(file); const requestedParent = resolve(dirname(childFile), parent); const parentFile = realpathSync(requestedParent);
      if (childFile === parentFile) throw new Error("parent session path is self-referential");
      const bytes = stableRead(parentFile); const entries = bytes.toString("utf8").split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as unknown);
      const headers = entries.filter((entry): entry is JsonObject => object(entry) && entry.type === "session"); if (headers.length !== 1) throw new Error("parent session must contain exactly one header");
      const parentHeader = headers[0] as Header; if (!safeId(parentHeader.id) || parentHeader.id === id) throw new Error("invalid parent session header");
      validateParentSessionBinding(parentFile, parentHeader.id, parentHeader);
      const branch = activeBranch(entries); const leaf = branch.at(-1); const observedLeafId = leaf && typeof leaf.id === "string" ? leaf.id : null;
      let parentCapsule: InheritanceCapsuleV1 | undefined; let ancestorSessionIds = [parentHeader.id];
      if (parentHeader.parentSession || (Number.isSafeInteger(parentHeader.rlmDepth) && (parentHeader.rlmDepth as number) > 0)) {
        const chain = this.readAndValidateChain(parentFile, parentHeader.id); parentCapsule = chain.capsule; ancestorSessionIds = chain.ancestors;
      }
      if (parentCapsule && parentCapsule.generation + 2 !== headerDepth) throw new Error("descendant depth does not match validated capsule generation");
      if (!parentCapsule && headerDepth !== 1) throw new Error("descendant depth lacks validated intermediate lineage");
      const pinBase = { version: PIN_VERSION, childSessionId: id, childSessionFile: childFile, parentSessionId: parentHeader.id, parentSessionFile: parentFile, depth: headerDepth,
        observedLeafId, sourceBytes: bytes.length, sourceDigest: sha(bytes), branchDigest: canonicalJsonDigest(branch), records: eligibleRecords(branch), ...(parentCapsule ? { parentCapsule } : {}), ancestorSessionIds } as const;
      const pin = pinBase as ObservedParentPin; const root = rootFor(childFile); ensureSessionBinding(childFile, id, { ...h, parentSession: parentFile, rlmDepth: headerDepth });
      if (reason === "resume" || reason === "reload") {
        const existing = this.tryReadAdmitted(childFile, id); if (existing) {
          if (existing.admission.parentSessionId !== pin.parentSessionId || existing.admission.parentSessionFile !== pin.parentSessionFile || existing.admission.depth !== pin.depth) throw new Error("resumed admission parent binding mismatch");
          if (canonicalJsonDigest(existing.pin) !== existing.admission.pinDigest
            || existing.pin.childSessionId !== id || existing.pin.childSessionFile !== childFile
            || existing.pin.parentSessionId !== pin.parentSessionId || existing.pin.parentSessionFile !== pin.parentSessionFile
            || existing.pin.depth !== pin.depth || existing.pin.sourceBytes > bytes.length
            || sha(bytes.subarray(0, existing.pin.sourceBytes)) !== existing.pin.sourceDigest) throw new Error("resumed admission original pin mismatch");
          const content = renderInheritanceCapsule(existing.capsule); const branchNow = (ctx.sessionManager.getBranch?.() ?? []) as readonly unknown[]; const inherited = customMessages(branchNow);
          if (branchNow.length && (inherited.length !== 1 || inherited[0]?.content !== content || !object(inherited[0]?.details) || inherited[0]?.details?.admissionDigest !== existing.admission.digest || inherited[0]?.details?.taskDigest !== existing.admission.taskDigest)) throw new Error("canonical inherited-context message is missing or mismatched");
          this.runtime.set(id, { prompt: existing.admission.taskText, taskDigest: existing.admission.taskDigest, content, admission: existing.admission }); return this.save(id, { state: branchNow.length ? "observed" : "admitted", ...existing });
        }
        if (customMessages(ctx.sessionManager.getBranch?.() ?? []).length) throw new Error("persisted inherited-context message has no admission");
        throw new Error("persisted descendant inheritance admission is missing");
      }
      const pinDigest = canonicalJsonDigest(pin); publish(root, "PINNED", { "pin.json": pin }, pinDigest); return this.save(id, { state: "pinned", pin });
    } catch (error) { return this.degrade(ctx, error instanceof Error ? error.message : String(error)); }
  }

  beforeStart(prompt: string, ctx: ExtensionContext, images?: BeforeAgentStartEvent["images"]): { message?: { customType: string; content: string; display: boolean; details: JsonObject } } | undefined {
    const id = this.id(ctx); const state = this.status(ctx); if (state.state !== "pinned") return;
    try {
      const pin = state.pin; const capsule = buildInheritanceCapsule({ recipientSessionId: id, parentSessionId: pin.parentSessionId, ...(pin.parentCapsule ? { parentCapsule: pin.parentCapsule } : {}), parentRecords: rank(pin.records, prompt), ancestorSessionIds: pin.ancestorSessionIds,
        limits: { maxEvidenceChars: 768, maxRecords: 6, reserveImmediateChars: 384, reserveImmediateRecords: 3 } });
      const check = validateCapsuleLineage(capsule, { ...(pin.parentCapsule ? { parentCapsule: pin.parentCapsule } : {}), ancestorSessionIds: pin.ancestorSessionIds }); if (!check.ok) throw new Error(check.reason);
      const expectedGeneration = (pin.parentCapsule?.generation ?? ROOT_INHERITANCE_GENERATION) + 1;
      if (capsule.generation !== expectedGeneration || pin.depth !== capsule.generation + 1) throw new Error("capsule generation/header depth invariant mismatch");
      const payload: InheritancePayload = { version: INHERITANCE_PAYLOAD_VERSION, capsule }; const content = renderInheritanceCapsule(capsule); const boundTask = taskDigest(prompt, images);
      const payloadDigest = canonicalJsonDigest(payload); const pinDigest = canonicalJsonDigest(pin); const generationSeed = canonicalJsonDigest({ pinDigest, boundTask, payloadDigest, contentDigest: sha(content) });
      const base = { version: INHERITANCE_ADMISSION_VERSION, childSessionId: id, childSessionFile: pin.childSessionFile, parentSessionId: pin.parentSessionId, parentSessionFile: pin.parentSessionFile, depth: pin.depth,
        observedLeafId: pin.observedLeafId, pinDigest, taskDigest: boundTask, taskText: prompt, taskImageDigest: imageDigest(images), payloadDigest, contentDigest: sha(content), generation: `admitted-${generationSeed}` } as const;
      const admission: InheritanceAdmission = { ...base, digest: canonicalJsonDigest(base) };
      publish(rootFor(pin.childSessionFile), "ADMITTED", { "pin.json": pin, "payload.json": payload, "admission.json": admission }, admission.digest);
      const details: JsonObject = { version: INHERITANCE_PAYLOAD_VERSION, capsuleDigest: capsule.digest, admissionDigest: admission.digest, taskDigest: boundTask };
      this.runtime.set(id, { prompt, taskDigest: boundTask, content, admission }); this.save(id, { state: "admitted", capsule, admission }); return { message: { customType: INHERITED_CONTEXT_CUSTOM_TYPE, content, display: false, details } };
    } catch (error) { this.degrade(ctx, error instanceof Error ? error.message : String(error)); return; }
  }

  position(messages: ContextEvent["messages"], ctx: ExtensionContext): { messages?: ContextEvent["messages"] } | undefined {
    const run = this.runtime.get(this.id(ctx));
    const typed = messages.filter((message): message is ContextEvent["messages"][number] & { role: "custom"; customType: string; content: string; details?: JsonObject } => message.role === "custom" && message.customType === INHERITED_CONTEXT_CUSTOM_TYPE);
    const without = messages.filter(message => !(message.role === "custom" && message.customType === INHERITED_CONTEXT_CUSTOM_TYPE));
    if (!run?.taskDigest || !run.content || !run.admission) {
      if (typed.length) { this.degrade(ctx, "inherited-context message has no active admission"); return { messages: without }; }
      return;
    }
    const valid = typed.filter(message => typeof message.content === "string" && object(message.details) && message.details.admissionDigest === run.admission!.digest && message.details.taskDigest === run.taskDigest && message.content === run.content);
    if (typed.length !== 1 || valid.length !== 1) {
      this.degrade(ctx, "suspicious or mismatched inherited-context message in request"); return { messages: without };
    }
    const capsule = valid[0];
    // Current turn is the last exact task-shaped message, never the first duplicate prompt in history.
    let target = -1;
    for (let index = without.length - 1; index >= 0; index--) {
      const message = without[index];
      if (message.role === "user" && plainText(message.content) === run.prompt) { target = index; break; }
      if (message.role === "custom" && typeof message.content === "string") {
        const raw = message.content.startsWith("[task from parent]\n\n") ? message.content.slice(20) : message.content;
        if (raw === run.prompt) { target = index; break; }
      }
    }
    if (target < 0) { this.degrade(ctx, "current task is absent or ambiguous"); return { messages: without }; }
    const output = [...without.slice(0, target), capsule, ...without.slice(target)];
    if (output.length === messages.length && output.every((message, index) => message === messages[index])) return;
    return { messages: output };
  }

  rebuild(ctx: ExtensionContext): InheritanceStatus { return this.start(ctx, "resume"); }
  private observe(ctx: ExtensionContext): void {
    const state = this.status(ctx); if (state.state !== "admitted") return;
    try {
      const id = this.id(ctx); const file = ctx.sessionManager.getSessionFile?.(); if (!file) throw new Error("session file unavailable during observation");
      const branch = (ctx.sessionManager.getBranch?.() ?? []) as readonly unknown[]; const found = customMessages(branch);
      const content = renderInheritanceCapsule(state.capsule); const message = found[0];
      if (found.length !== 1 || message?.content !== content || !object(message?.details)
        || message.details.admissionDigest !== state.admission.digest
        || message.details.taskDigest !== state.admission.taskDigest
        || message.details.capsuleDigest !== state.capsule.digest) throw new Error("persisted inherited context does not match admission");
      let taskMatches = 0;
      for (const entry of branch) {
        if (!object(entry)) continue;
        if (entry.type === "message" && object(entry.message) && entry.message.role === "user" && plainText(entry.message.content) === state.admission.taskText) taskMatches++;
        if (entry.type === "custom_message" && entry.customType !== INHERITED_CONTEXT_CUSTOM_TYPE && typeof entry.content === "string") {
          const raw = entry.content.startsWith("[task from parent]\n\n") ? entry.content.slice(20) : entry.content;
          if (raw === state.admission.taskText) taskMatches++;
        }
      }
      if (taskMatches < 1) throw new Error("observed admission has no bound task turn");
      const admitted = this.readAdmitted(file, id); const payload: InheritancePayload = { version: INHERITANCE_PAYLOAD_VERSION, capsule: state.capsule };
      publish(rootFor(file), "OBSERVED", { "pin.json": admitted.pin, "payload.json": payload, "admission.json": state.admission,
        "observation.json": { admissionDigest: state.admission.digest, contentDigest: sha(content), taskDigest: state.admission.taskDigest, branchDigest: canonicalJsonDigest(branch) } }, state.admission.digest);
      this.save(id, { state: "observed", capsule: state.capsule, admission: state.admission });
    } catch (error) { this.degrade(ctx, error instanceof Error ? error.message : String(error)); }
  }
  private readAndValidateChain(file: string, id: string): { capsule: InheritanceCapsuleV1; ancestors: string[] } {
    const seen = new Set<string>(); const reverse: Array<{ id: string; capsule: InheritanceCapsuleV1; admission: InheritanceAdmission }> = []; let currentFile = file; let currentId = id; let rootId: string | undefined;
    for (;;) {
      if (seen.has(currentId)) throw new Error("inheritance lineage cycle"); seen.add(currentId);
      const bytes = stableRead(currentFile); const entries = bytes.toString("utf8").split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as unknown); const h = entries.find((x): x is JsonObject => object(x) && x.type === "session") as Header | undefined;
      if (!h || h.id !== currentId) throw new Error("lineage session binding mismatch");
      validateParentSessionBinding(currentFile, currentId, h);
      if (!h.parentSession) { if (Number.isSafeInteger(h.rlmDepth) && h.rlmDepth !== 0) throw new Error("lineage root depth mismatch"); rootId = currentId; break; }
      const admitted = this.readAdmitted(currentFile, currentId, true); if (admitted.admission.depth !== admitted.capsule.generation + 1) throw new Error("lineage admission depth mismatch"); reverse.push({ id: currentId, ...admitted });
      const parentFile = realpathSync(resolve(dirname(currentFile), h.parentSession)); if (parentFile !== admitted.admission.parentSessionFile) throw new Error("lineage admission parent file mismatch");
      const pbytes = stableRead(parentFile); const parentHeaders = pbytes.toString("utf8").split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as unknown).filter((x): x is JsonObject => object(x) && x.type === "session");
      if (parentHeaders.length !== 1 || !safeId(parentHeaders[0]?.id) || parentHeaders[0]?.id !== admitted.admission.parentSessionId) throw new Error("invalid lineage parent header"); currentFile = parentFile; currentId = parentHeaders[0].id;
    }
    reverse.reverse(); let prior: InheritanceCapsuleV1 | undefined; if (!rootId) throw new Error("lineage root is unavailable"); const ancestors: string[] = [rootId];
    for (const edge of reverse) { if (edge.capsule.parentSessionId !== ancestors.at(-1)) throw new Error("reparented capsule lineage"); const validation = validateCapsuleLineage(edge.capsule, { ...(prior ? { parentCapsule: prior } : {}), ancestorSessionIds: ancestors }); if (!validation.ok) throw new Error(`invalid capsule lineage: ${validation.reason}`); ancestors.push(edge.id); prior = edge.capsule; }
    if (!prior) throw new Error("descendant lineage has no admission"); return { capsule: prior, ancestors };
  }
  private tryReadAdmitted(file: string, id: string): { pin: ObservedParentPin; capsule: InheritanceCapsuleV1; admission: InheritanceAdmission } | undefined { try { return this.readAdmitted(file, id); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; } }
  private readAdmitted(file: string, id: string, requireObserved = false): { pin: ObservedParentPin; capsule: InheritanceCapsuleV1; admission: InheritanceAdmission } {
    const { head, dir } = readHead(file); if ((head.state !== "ADMITTED" && head.state !== "OBSERVED") || (requireObserved && head.state !== "OBSERVED")) throw Object.assign(new Error("inheritance admission is missing"), { code: "ENOENT" });
    const pin = safeJson(join(dir, "pin.json")); const payload = safeJson(join(dir, "payload.json")); const raw = safeJson(join(dir, "admission.json"));
    if (pin.version !== PIN_VERSION || payload.version !== INHERITANCE_PAYLOAD_VERSION || raw.version !== INHERITANCE_ADMISSION_VERSION) throw new Error("unsupported inheritance admission version");
    const capsule = payload.capsule as InheritanceCapsuleV1; const valid = validateCapsule(capsule); if (!valid.ok || capsule.recipientSessionId !== id) throw new Error(valid.ok ? "capsule recipient mismatch" : valid.reason);
    const admission = raw as unknown as InheritanceAdmission; const { digest, ...base } = admission; if (canonicalJsonDigest(base) !== digest || head.digest !== digest) throw new Error("admission/head digest mismatch");
    if (admission.childSessionId !== id || realpathSync(admission.childSessionFile) !== realpathSync(file) || typeof admission.taskText !== "string" || !/^[a-f0-9]{64}$/.test(admission.taskImageDigest) || canonicalJsonDigest({ prompt: admission.taskText, imageDigest: admission.taskImageDigest }) !== admission.taskDigest || canonicalJsonDigest(pin) !== admission.pinDigest || canonicalJsonDigest(payload) !== admission.payloadDigest || sha(renderInheritanceCapsule(capsule)) !== admission.contentDigest) throw new Error("admission binding mismatch");
    return { pin: pin as unknown as ObservedParentPin, capsule, admission };
  }
  private id(ctx: ExtensionContext): string { return ctx.sessionManager.getSessionId?.() ?? ctx.cwd; }
  private save(id: string, status: InheritanceStatus): InheritanceStatus { this.statuses.set(id, status); return status; }
  private degrade(ctx: ExtensionContext, reason: string): InheritanceStatus { ctx.ui?.notify?.(`DSH automatic inherited context degraded: ${reason}`, "warning"); return this.save(this.id(ctx), { state: "degraded", reason }); }
}
