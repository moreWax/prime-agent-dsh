import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_VERSION = "prime-agent-dsh/derived-commit-v1";
const OBJECT_VERSION = "prime-agent-dsh/derived-object-v3-reference";
const STORE_VERSION = "prime-agent-dsh/durable-store-v3-reference";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordValue = Record<string, unknown>;
export type QueryMode = "literal" | "regex" | "full-text";
export type QueryScope = "effective" | "source";

export interface DurableContextQueryOptions {
  readonly root: string;
  readonly sessionId: string;
  readonly primeSessionFile: string;
  readonly maxCheckpoints?: number;
  readonly maxResults?: number;
  readonly maxQueryBytes?: number;
  readonly maxScannedEntries?: number;
}
export interface CheckpointFilter {
  readonly branchIds?: readonly string[];
  readonly generations?: { readonly min?: number; readonly max?: number };
  readonly commitDigests?: readonly string[];
}
export interface ContextQueryRequest {
  readonly query: string;
  readonly mode?: QueryMode;
  readonly scope?: QueryScope;
  readonly regexFlags?: string;
  readonly filter?: CheckpointFilter;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface ProvenanceTrace {
  readonly sessionId: string;
  readonly primeSessionFile: string;
  readonly bindingDigest: string;
  readonly head: string;
  readonly commitDigest: string;
  readonly generation: number;
  readonly parentCommitDigest: string | null;
  readonly objectDigest: string;
  readonly sourceDigest: string;
  readonly effectiveDigest: string;
  readonly branchId: string;
  readonly scope: QueryScope;
  readonly entryIndex: number;
  readonly entryDigest: string;
  /** True when the returned value reconstructs the referenced entry exactly. */
  readonly exactBody: boolean;
}
export interface ContextQueryHit {
  readonly text: string;
  readonly value: Json | undefined;
  readonly score: number | undefined;
  readonly truncated: boolean;
  readonly trace: ProvenanceTrace;
}
export interface ContextQueryPage {
  readonly hits: readonly ContextQueryHit[];
  readonly nextCursor?: string;
  readonly scannedEntries: number;
  readonly skippedCorruptCheckpoints: number;
  readonly snapshotGeneration: number;
  /** Effective entries that cannot be reconstructed losslessly from Prime source. */
  readonly unavailableEffectiveEntries: number;
}
export interface ContextCheckpoint {
  readonly commitDigest: string; readonly generation: number; readonly branchId: string;
  readonly parentCommitDigest: string | null; readonly objectDigest: string;
  readonly sourceDigest: string; readonly effectiveDigest: string; readonly observedAt: number;
}

function obj(value: unknown): RecordValue | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined; }
function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) { if (seen.has(value)) throw new TypeError("cyclic JSON"); seen.add(value); const out = `[${value.map(v => canonical(v, seen)).join(",")}]`; seen.delete(value); return out; }
  const record = obj(value); if (record) { if (seen.has(record)) throw new TypeError("cyclic JSON"); seen.add(record); const out = `{${Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${canonical(record[k], seen)}`).join(",")}}`; seen.delete(record); return out; }
  throw new TypeError("not JSON");
}
function hashText(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function digest(value: unknown): string { return hashText(canonical(value)); }
function safeText(path: string, maximum = 32 * 1024 * 1024): string { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error(`unsafe or oversized query file: ${path}`); return readFileSync(path, "utf8"); }
function parse(path: string): unknown { return JSON.parse(safeText(path)); }
function semanticText(value: unknown): string {
  const r = obj(value); if (r) { if (typeof r.text === "string") return r.text; if (typeof r.content === "string") return r.content; const m = obj(r.message); if (typeof m?.content === "string") return m.content; if (typeof m?.summary === "string") return m.summary; }
  return canonical(value);
}
function tokens(text: string): string[] { return text.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_]+/gu) ?? []; }
function encode(value: unknown): string { return Buffer.from(canonical(value)).toString("base64url"); }
function decode(value: string): RecordValue { if (Buffer.byteLength(value) > 4096) throw new Error("invalid query cursor"); try { const parsed = obj(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))); if (parsed) return parsed; } catch { /* below */ } throw new Error("invalid query cursor"); }
function validPositive(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }

interface Loaded { head: string; commitDigest: string; commit: RecordValue; object: RecordValue; branchId: string; source: Json[]; effective: Json[]; effectiveExact: boolean[] }
interface Candidate { hit: ContextQueryHit; sort: readonly (string | number)[] }

/**
 * Read-only query adapter for DurableContextStore publications.
 * Prime JSONL is canonical. This adapter validates and derives every view from immutable
 * store commits, so any optional external FTS index can be deleted and rebuilt.
 */
export class DurableContextQuery {
  readonly root: string;
  readonly sessionId: string;
  readonly primeSessionFile: string;
  readonly bindingDigest: string;
  private readonly maxCheckpoints: number; private readonly maxResults: number;
  private readonly maxQueryBytes: number; private readonly maxScannedEntries: number;

  constructor(options: DurableContextQueryOptions) {
    if (!isAbsolute(options.root) || !isAbsolute(options.primeSessionFile)) throw new Error("query paths must be absolute");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(options.sessionId)) throw new Error("invalid session id");
    this.root = realpathSync(options.root); this.primeSessionFile = realpathSync(options.primeSessionFile); this.sessionId = options.sessionId;
    this.maxCheckpoints = options.maxCheckpoints ?? 128; this.maxResults = options.maxResults ?? 100;
    this.maxQueryBytes = options.maxQueryBytes ?? 4096; this.maxScannedEntries = options.maxScannedEntries ?? 100_000;
    if (![this.maxCheckpoints, this.maxResults, this.maxQueryBytes, this.maxScannedEntries].every(validPositive)) throw new Error("query limits must be positive integers");
    this.bindingDigest = digest({ sessionId: this.sessionId, primeSessionFile: this.primeSessionFile });
    const binding = obj(parse(join(this.root, "BINDING")));
    if (!binding || binding.version !== STORE_VERSION || binding.sessionId !== this.sessionId || binding.primeSessionFile !== this.primeSessionFile || binding.bindingDigest !== this.bindingDigest) throw new Error("durable query is bound to another Prime session");
  }

  private load(cutoff = Number.MAX_SAFE_INTEGER): { values: Loaded[]; corrupt: number } {
    const headsPath = join(this.root, "heads"); const stat = lstatSync(headsPath); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe heads directory");
    const names = readdirSync(headsPath).filter(n => /^\d{16}-[a-f0-9]{64}$/.test(n) && Number(n.slice(0, 16)) <= cutoff).sort().reverse();
    const values: Loaded[] = []; let corrupt = 0;
    for (const head of names) try {
      const commitDigest = head.slice(17); if (safeText(join(headsPath, head)).trim() !== commitDigest) throw new Error();
      const commitRaw = safeText(join(this.root, "commits", `${commitDigest}.json`)).trim(); if (hashText(commitRaw) !== commitDigest) throw new Error();
      const commit = obj(JSON.parse(commitRaw)); if (!commit || commit.version !== COMMIT_VERSION || commit.bindingDigest !== this.bindingDigest || commit.generation !== Number(head.slice(0, 16)) || typeof commit.object !== "string" || !SHA256.test(commit.object) || typeof commit.sourceDigest !== "string" || !SHA256.test(commit.sourceDigest) || typeof commit.effectiveDigest !== "string" || !SHA256.test(commit.effectiveDigest) || (commit.parent !== null && (typeof commit.parent !== "string" || !SHA256.test(commit.parent)))) throw new Error();
      const objectRaw = safeText(join(this.root, "objects", `${commit.object}.json`)).trim(); if (hashText(objectRaw) !== commit.object) throw new Error();
      const object = obj(JSON.parse(objectRaw)); const compatibility = obj(object?.compatibility);
      if (!object || object.version !== OBJECT_VERSION || object.bindingDigest !== this.bindingDigest || object.sourceDigest !== commit.sourceDigest || object.effectiveDigest !== commit.effectiveDigest || !Array.isArray(object.sourceEntryDigests) || !(object.sourceEntryDigests as unknown[]).every(v => typeof v === "string" && SHA256.test(v)) || !Array.isArray(object.effectiveEntryDigests) || !(object.effectiveEntryDigests as unknown[]).every(v => typeof v === "string" && SHA256.test(v)) || !compatibility || compatibility.version !== STORE_VERSION || compatibility.sessionId !== this.sessionId || compatibility.revision !== commit.generation || compatibility.sourceDigest !== commit.sourceDigest || compatibility.effectiveDigest !== commit.effectiveDigest || typeof compatibility.branchId !== "string" || !Array.isArray(compatibility.entries) || typeof compatibility.cropped !== "boolean") throw new Error();
      if ("effective" in object || compatibility.messages !== undefined || !Array.isArray(object.sourceLocators)
        || !Array.isArray(object.effectiveReferences) || object.sourceLocators.length !== object.sourceEntryDigests.length
        || object.effectiveReferences.length !== object.effectiveEntryDigests.length || compatibility.entries.length !== 0) throw new Error();
      const prime = readFileSync(this.primeSessionFile);
      const source = object.sourceLocators.map((raw, index) => {
        const locator = obj(raw); const expected = (object.sourceEntryDigests as string[])[index];
        if (!locator || locator.index !== index || !Number.isSafeInteger(locator.byteOffset) || (locator.byteOffset as number) < 0
          || !Number.isSafeInteger(locator.byteLength) || (locator.byteLength as number) <= 0 || !Number.isSafeInteger(locator.line)
          || (locator.line as number) <= 0 || locator.entryDigest !== expected || (locator.entryId !== undefined && typeof locator.entryId !== "string")) throw new Error();
        const start = locator.byteOffset as number, end = start + (locator.byteLength as number);
        if (end > prime.length || (start > 0 && prime[start - 1] !== 0x0a)
          || (end < prime.length && prime[end] !== 0x0a && !(prime[end] === 0x0d && prime[end + 1] === 0x0a))) throw new Error();
        const value = JSON.parse(prime.subarray(start, end).toString("utf8")) as Json;
        if (digest(value) !== expected || (locator.entryId !== undefined && obj(value)?.id !== locator.entryId)) throw new Error();
        return value;
      });
      if (digest(source) !== object.sourceDigest) throw new Error();
      const effectiveExact: boolean[] = [];
      const effective = object.effectiveReferences.map((raw, index) => {
        const reference = obj(raw); const expected = (object.effectiveEntryDigests as string[])[index];
        if (!reference || reference.entryDigest !== expected || (reference.role !== undefined && typeof reference.role !== "string")
          || (reference.sourceIndex !== null && (!Number.isSafeInteger(reference.sourceIndex) || (reference.sourceIndex as number) < 0 || (reference.sourceIndex as number) >= source.length))) throw new Error();
        if (reference.sourceIndex === null) { effectiveExact.push(false); return null; }
        const entry = source[reference.sourceIndex as number]!;
        if (digest(entry) === expected) { effectiveExact.push(true); return entry; }
        const message = obj(entry)?.message;
        effectiveExact.push(message !== undefined && digest(message) === expected);
        return (message === undefined ? entry : message) as Json;
      });
      if (compatibility.messageCount !== effective.length) throw new Error();
      values.push({ head, commitDigest, commit, object, branchId: compatibility.branchId, source, effective, effectiveExact });
      if (values.length >= this.maxCheckpoints) break;
      continue;
    } catch { corrupt++; }
    return { values, corrupt };
  }

  listCheckpoints(filter: CheckpointFilter = {}): readonly ContextCheckpoint[] {
    return this.load().values.filter(v => this.matches(v, filter)).map(v => ({ commitDigest: v.commitDigest, generation: v.commit.generation as number, branchId: v.branchId, parentCommitDigest: v.commit.parent as string | null, objectDigest: v.commit.object as string, sourceDigest: v.commit.sourceDigest as string, effectiveDigest: v.commit.effectiveDigest as string, observedAt: typeof v.commit.observedAt === "number" ? v.commit.observedAt : 0 }));
  }
  private matches(v: Loaded, filter: CheckpointFilter): boolean {
    if (filter.branchIds && !filter.branchIds.includes(v.branchId)) return false;
    if (filter.commitDigests && !filter.commitDigests.includes(v.commitDigest)) return false;
    const generation = v.commit.generation as number;
    if (filter.generations?.min !== undefined && generation < filter.generations.min) return false;
    if (filter.generations?.max !== undefined && generation > filter.generations.max) return false;
    return true;
  }

  query(request: ContextQueryRequest): ContextQueryPage {
    if (typeof request.query !== "string" || Buffer.byteLength(request.query) > this.maxQueryBytes) throw new Error("query exceeds configured bound");
    const mode = request.mode ?? "literal", scope = request.scope ?? "effective";
    if (!["literal", "regex", "full-text"].includes(mode) || !["effective", "source"].includes(scope)) throw new Error("invalid query mode or scope");
    const limit = request.limit ?? Math.min(20, this.maxResults); if (!validPositive(limit) || limit > this.maxResults) throw new Error("query result limit exceeds configured bound");
    const requestKey = digest({ query: request.query, mode, scope, regexFlags: request.regexFlags ?? "", filter: request.filter ?? {} });
    let cutoff = Number.MAX_SAFE_INTEGER, offset = 0; let cursorSnapshot: string | undefined; let cursorCeiling: string | undefined;
    if (request.cursor) { const c = decode(request.cursor); if (c.v !== 2 || c.key !== requestKey || !Number.isSafeInteger(c.cutoff) || !Number.isSafeInteger(c.offset) || (c.offset as number) < 0 || typeof c.snapshot !== "string" || !SHA256.test(c.snapshot) || typeof c.ceiling !== "string" || !SHA256.test(c.ceiling)) throw new Error("query cursor does not match request"); cutoff = c.cutoff as number; offset = c.offset as number; cursorSnapshot = c.snapshot; cursorCeiling = c.ceiling; }
    const loaded = this.load(cutoff); if (!request.cursor) cutoff = Math.max(0, ...loaded.values.map(v => v.commit.generation as number));
    const snapshotIdentity = digest(loaded.values.map(v => ({ head: v.head, commit: v.commitDigest, object: v.commit.object })).sort((a,b) => a.head.localeCompare(b.head)));
    const ceilingIdentity = loaded.values.find(v => v.commit.generation === cutoff)?.commitDigest ?? digest([]);
    if (request.cursor && (snapshotIdentity !== cursorSnapshot || ceilingIdentity !== cursorCeiling)) throw new Error("query cursor snapshot is no longer available");
    const selected = loaded.values.filter(v => this.matches(v, request.filter ?? {}));
    let regex: RegExp | undefined; if (mode === "regex") { const flags = request.regexFlags ?? "iu"; if (!/^(?!.*(.).*\1)[imu]*$/.test(flags)) throw new Error("unsupported regex flags"); try { regex = new RegExp(request.query, flags); } catch { throw new Error("invalid regular expression"); } }
    const needle = request.query.trim().split(/\s+/u).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    const literal = mode === "literal" ? new RegExp(needle, "iu") : undefined;
    const queryTokens = tokens(request.query); if (mode === "full-text" && queryTokens.length === 0) throw new Error("full-text query has no searchable terms");
    const docs: { loaded: Loaded; index: number; text: string; value: Json | undefined; digest: string; truncated: boolean; exact: boolean }[] = [];
    let unavailableEffectiveEntries = 0;
    for (const v of selected) {
      if (scope === "effective") v.effective.forEach((value, index) => { if (value !== null) docs.push({ loaded: v, index, text: semanticText(value), value, digest: (v.object.effectiveEntryDigests as string[])[index], truncated: false, exact: v.effectiveExact?.[index] ?? true }); else unavailableEffectiveEntries++; });
      else v.source.forEach((value, index) => docs.push({ loaded: v, index, text: semanticText(value), value, digest: (v.object.sourceEntryDigests as string[])[index], truncated: false, exact: true }));
      if (docs.length > this.maxScannedEntries) throw new Error("query scan exceeds configured bound");
    }
    const df = new Map<string, number>(); if (mode === "full-text") for (const d of docs) for (const t of new Set(tokens(d.text))) df.set(t, (df.get(t) ?? 0) + 1);
    const avg = docs.length ? docs.reduce((n, d) => n + tokens(d.text).length, 0) / docs.length : 1;
    const candidates: Candidate[] = [];
    for (const d of docs) {
      let score: number | undefined; let match: boolean;
      if (literal) match = literal.test(d.text); else if (regex) { regex.lastIndex = 0; match = regex.test(d.text); }
      else { const ts = tokens(d.text), counts = new Map<string, number>(); for (const t of ts) counts.set(t, (counts.get(t) ?? 0) + 1); score = 0; for (const q of queryTokens) { const tf = counts.get(q) ?? 0; if (!tf) continue; const idf = Math.log(1 + (docs.length - (df.get(q) ?? 0) + .5) / ((df.get(q) ?? 0) + .5)); score += idf * tf * 2.2 / (tf + 1.2 * (.25 + .75 * ts.length / avg)); } match = score > 0; score = Number(score.toFixed(12)); }
      if (!match) continue;
      const v = d.loaded, generation = v.commit.generation as number;
      const trace: ProvenanceTrace = { sessionId: this.sessionId, primeSessionFile: this.primeSessionFile, bindingDigest: this.bindingDigest, head: v.head, commitDigest: v.commitDigest, generation, parentCommitDigest: v.commit.parent as string | null, objectDigest: v.commit.object as string, sourceDigest: v.commit.sourceDigest as string, effectiveDigest: v.commit.effectiveDigest as string, branchId: v.branchId, scope, entryIndex: d.index, entryDigest: d.digest, exactBody: d.exact };
      const hit = { text: d.text, value: d.value, score, truncated: d.truncated, trace };
      candidates.push({ hit, sort: mode === "full-text" ? [-(score ?? 0), -generation, d.index, v.commitDigest] : [-generation, d.index, v.commitDigest] });
    }
    candidates.sort((a, b) => { for (let i = 0; i < a.sort.length; i++) { const x=a.sort[i], y=b.sort[i]; if (x < y) return -1; if (x > y) return 1; } return 0; });
    const hits = candidates.slice(offset, offset + limit).map(c => c.hit); const next = offset + limit < candidates.length ? encode({ v: 2, key: requestKey, cutoff, snapshot: snapshotIdentity, ceiling: ceilingIdentity, offset: offset + limit }) : undefined;
    return { hits, ...(next ? { nextCursor: next } : {}), scannedEntries: docs.length, skippedCorruptCheckpoints: loaded.corrupt, snapshotGeneration: cutoff, unavailableEffectiveEntries };
  }
}
