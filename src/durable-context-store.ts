import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync,
  realpathSync, readdirSync, renameSync, rmSync, statfsSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const DURABLE_STORE_VERSION = "prime-agent-dsh/durable-store-v3-reference" as const;
export const DURABLE_OBJECT_VERSION = "prime-agent-dsh/derived-object-v3-reference" as const;
export const DURABLE_COMMIT_VERSION = "prime-agent-dsh/derived-commit-v1" as const;
const SHA256 = /^[a-f0-9]{64}$/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface StoreBinding {
  readonly sessionId: string;
  /** Path to Prime's canonical JSONL. It is identified by its real path, never read or modified. */
  readonly primeSessionFile: string;
}
export interface PublishInput {
  /** Exact Prime records used to derive this view. */
  readonly source: readonly unknown[];
  /** Exact converted records consumed by the derived context reader. */
  readonly effective: readonly unknown[];
  /** Prime source entry for each effective message; null only when no public mapping exists. */
  readonly effectiveSourceIndexes?: readonly (number | null)[];
  readonly converterVersion: string;
  readonly schemaVersion: string;
  readonly compatibilityMetrics?: Readonly<Record<string, number>>;
  readonly cropped?: boolean;
  /** Optional exact leaf identifier for diagnostic/compatibility views. */
  readonly branchId?: string;
  readonly observedAt?: number;
}
export interface CompatibilityView {
  readonly version: typeof DURABLE_STORE_VERSION;
  readonly sessionId: string;
  readonly branchId: string;
  readonly revision: number;
  readonly messageCount: number;
  readonly entries: readonly [];
  readonly cropped: boolean;
  readonly sourceDigest: string;
  readonly effectiveDigest: string;
  readonly converterVersion: string;
  readonly schemaVersion: string;
  readonly metrics?: Readonly<Record<string, number>>;
}
export interface SourceLocator {
  readonly index: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly line: number;
  readonly entryDigest: string;
  readonly entryId?: string;
}
export interface EffectiveReference {
  readonly entryDigest: string;
  readonly sourceIndex: number | null;
  readonly role?: string;
}
export interface DerivedObject {
  readonly version: typeof DURABLE_OBJECT_VERSION;
  readonly bindingDigest: string;
  readonly sourceDigest: string;
  readonly effectiveDigest: string;
  readonly sourceEntryDigests: readonly string[];
  readonly effectiveEntryDigests: readonly string[];
  readonly sourceLocators: readonly SourceLocator[];
  readonly effectiveReferences: readonly EffectiveReference[];
  readonly compatibility: CompatibilityView;
}
export type EffectiveProjectionRebuildReason = "initial" | "none" | "converter-change" | "source-diverged" | "source-append-effective-projection-change" | "effective-diverged";
export interface PrimeIndexDiagnostics {
  readonly mode: "full" | "tail" | "cache";
  readonly bytesProcessed: number;
  readonly linesProcessed: number;
}
export interface PublicationDiagnostics {
  readonly source: { readonly mode: "append" | "rebuild" | "noop"; readonly reused: number; readonly new: number; readonly reindexed: number };
  readonly index?: PrimeIndexDiagnostics;
  readonly effective: { readonly reused: number; readonly new: number; readonly reindexed: number; readonly rebuildReason: EffectiveProjectionRebuildReason };
}
export interface DerivedCommit {
  readonly version: typeof DURABLE_COMMIT_VERSION;
  readonly bindingDigest: string;
  readonly generation: number;
  readonly parent: string | null;
  readonly object: string;
  readonly sourceDigest: string;
  readonly effectiveDigest: string;
  readonly converterVersion: string;
  readonly schemaVersion: string;
  readonly mode: "append" | "rebuild";
  readonly commonPrefix: number;
  readonly observedAt: number;
  readonly publication?: PublicationDiagnostics;
}
export interface RecoveredGeneration {
  readonly commitDigest: string;
  readonly commit: DerivedCommit;
  readonly object: DerivedObject;
}
export interface PublishResult extends RecoveredGeneration { readonly mode: "append" | "rebuild" | "noop"; readonly publication: PublicationDiagnostics }
export type FaultBoundary = "object-durable" | "commit-durable" | "head-durable" | "current-temp-durable" | "current-replaced";

export class DurablePublicationUnavailableError extends Error {
  readonly code = "DURABLE_PUBLICATION_UNAVAILABLE";
  constructor(message: string) { super(message); this.name = "DurablePublicationUnavailableError"; }
}

export interface DurableContextStoreOptions {
  readonly root: string;
  readonly binding: StoreBinding;
  readonly recoveryScanLimit?: number;
  readonly maxObjectBytes?: number;
  /** Maximum bytes allowed for the private, content-free Prime JSONL index. */
  readonly maxIndexBytes?: number;
  /** Maximum bytes owned by the rebuildable derived store. */
  readonly maxStoreBytes?: number;
  /** Refuse a publication that would leave less filesystem space than this. */
  readonly minFreeBytes?: number;
  /** Complete generations retained after a successful publication. */
  readonly retainGenerations?: number;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
  readonly fault?: (boundary: FaultBoundary) => void;
  readonly now?: () => number;
}

function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) { const code = value.charCodeAt(i); if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; } else if (code >= 0xdc00 && code <= 0xdfff) return false; } return true;
}
function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") { if (!wellFormed(value)) throw new TypeError("derived context strings must be well-formed Unicode"); return JSON.stringify(value); }
  if (typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("derived context must contain finite JSON numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("derived context must not contain cycles");
    seen.add(value); const result = `[${value.map((item) => canonical(item, seen)).join(",")}]`; seen.delete(value); return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError("derived context must not contain cycles");
    const record = value as Record<string, unknown>;
    const prototype = Reflect.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("derived context must contain plain JSON objects");
    seen.add(record);
    const fields: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
        throw new TypeError(`derived context field ${key} is not JSON`);
      }
      fields.push(`${JSON.stringify(key)}:${canonical(item, seen)}`);
    }
    seen.delete(record); return `{${fields.join(",")}}`;
  }
  throw new TypeError("derived context must be JSON");
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function safeFileText(path: string, maximum = 32 * 1024 * 1024): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error(`unsafe or oversized durable store file: ${path}`);
  return readFileSync(path, "utf8");
}
function parseJson(path: string): unknown { return JSON.parse(safeFileText(path)) as unknown; }
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function safeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function syncDirectory(path: string): void {
  let fd: number | undefined;
  try { fd = openSync(path, constants.O_RDONLY); fsyncSync(fd); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF") throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
function canonicalNewPath(path: string): string {
  let cursor = resolve(path); const suffix: string[] = [];
  while (!existsSync(cursor)) { suffix.unshift(cursor.slice(dirname(cursor).length + (dirname(cursor) === sep ? 0 : 1))); cursor = dirname(cursor); }
  return join(realpathSync(cursor), ...suffix);
}
function ensureNoSymlink(path: string): void {
  const absolute = resolve(path); let cursor = absolute;
  const pending: string[] = [];
  while (!existsSync(cursor)) { pending.push(cursor); const parent = dirname(cursor); if (parent === cursor) break; cursor = parent; }
  while (true) {
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed in durable store path: ${cursor}`);
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  void pending;
}
function privateDirectory(path: string): void {
  ensureNoSymlink(path); mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe durable store directory: ${path}`);
}
function assertChild(root: string, path: string): void {
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`path escapes durable store: ${path}`);
}
function atomicWrite(path: string, contents: string, replace: boolean, beforeRename?: () => void, syncAfter = true): void {
  const directory = dirname(path); const temporary = join(directory, `.tmp-${process.pid}-${randomBytes(12).toString("hex")}`);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, contents, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  beforeRename?.();
  try {
    if (!replace && existsSync(path)) { unlinkSync(temporary); return; }
    renameSync(temporary, path); if (syncAfter) syncDirectory(directory);
  } catch (error) { try { unlinkSync(temporary); } catch { /* best effort */ } throw error; }
}
function sleep(ms: number): Promise<void> { return new Promise((accept) => setTimeout(accept, ms)); }

interface PrimeLine { offset: number; length: number; line: number; digest: string; id?: string }
interface PrimeIndexCursor {
  version: "prime-agent-dsh/prime-jsonl-index-v1";
  bindingDigest: string;
  identity: { dev: number; ino: number };
  byteOffset: number;
  nextLine: number;
  mtimeMs: number;
  sourceDigest: string;
  entries: PrimeLine[];
  checksum: string;
}

function readRange(fd: number, offset: number, length: number): Buffer {
  const result = Buffer.alloc(length); let done = 0;
  while (done < length) { const count = readSync(fd, result, done, length - done, offset + done); if (count === 0) throw new Error("Prime JSONL changed while it was read"); done += count; }
  return result;
}
function indexedDigest(entries: readonly PrimeLine[]): string {
  return digest(entries.map(({ offset, length, line, digest: entryDigest, id }) => ({ offset, length, line, digest: entryDigest, ...(id === undefined ? {} : { id }) })));
}
function parsePrimeBytes(raw: Buffer, baseOffset: number, firstLine: number): { entries: PrimeLine[]; nextLine: number } {
  const entries: PrimeLine[] = []; let start = 0, line = firstLine;
  const add = (endExclusive: number): void => {
    let end = endExclusive; if (end > start && raw[end - 1] === 0x0d) end--;
    if (end > start) {
      const bytes = raw.subarray(start, end); let value: unknown;
      try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`invalid Prime JSONL at line ${line}`); }
      const normalized = JSON.parse(canonical(value)) as Json; const record = object(normalized);
      entries.push({ offset: baseOffset + start, length: end - start, line, digest: digest(normalized), ...(typeof record?.id === "string" ? { id: record.id } : {}) });
    }
  };
  for (let cursor = 0; cursor < raw.length; cursor++) {
    if (raw[cursor] !== 0x0a) continue;
    add(cursor); start = cursor + 1; line++;
  }
  if (start < raw.length) { add(raw.length); line++; }
  return { entries, nextLine: line };
}

function validPrimeLine(value: unknown): value is PrimeLine {
  const item = object(value);
  return !!item && Number.isSafeInteger(item.offset) && (item.offset as number) >= 0
    && safeInteger(item.length) && safeInteger(item.line) && typeof item.digest === "string" && SHA256.test(item.digest)
    && (item.id === undefined || typeof item.id === "string");
}

/** A rebuildable, content-addressed publication store. Prime's JSONL remains authoritative. */
function reuseCounts(previous: readonly string[], next: readonly string[]): { reused: number; new: number; reindexed: number } {
  const remaining = new Map<string, number[]>();
  previous.forEach((value, index) => { const indexes = remaining.get(value) ?? []; indexes.push(index); remaining.set(value, indexes); });
  let reused = 0, added = 0, reindexed = 0;
  next.forEach((value, index) => {
    const indexes = remaining.get(value);
    if (!indexes?.length) { added++; return; }
    const same = indexes.indexOf(index);
    if (same >= 0) { indexes.splice(same, 1); reused++; } else { indexes.shift(); reindexed++; }
  });
  return { reused, new: added, reindexed };
}

export class DurableContextStore {
  readonly root: string;
  readonly binding: Readonly<StoreBinding & { primeSessionFile: string }>;
  readonly bindingDigest: string;
  private readonly scanLimit: number;
  private readonly maxObjectBytes: number;
  private readonly maxIndexBytes: number;
  private readonly maxStoreBytes: number;
  private readonly minFreeBytes: number;
  private readonly retainGenerations: number;
  private readonly lockTimeout: number;
  private readonly staleLock: number;
  private readonly fault?: (boundary: FaultBoundary) => void;
  private readonly now: () => number;

  constructor(options: DurableContextStoreOptions) {
    if (!isAbsolute(options.root)) throw new Error("durable store root must be absolute");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(options.binding.sessionId)) throw new Error("invalid session id");
    if (!isAbsolute(options.binding.primeSessionFile)) throw new Error("Prime session file must be absolute");
    if (existsSync(options.root) && lstatSync(options.root).isSymbolicLink()) throw new Error(`symlink is not allowed in durable store path: ${options.root}`);
    const canonicalRoot = canonicalNewPath(options.root);
    ensureNoSymlink(canonicalRoot);
    const sessionFile = realpathSync(options.binding.primeSessionFile);
    const sessionStat = statSync(sessionFile); if (!sessionStat.isFile()) throw new Error("Prime session binding is not a file");
    this.root = canonicalRoot;
    this.binding = Object.freeze({ sessionId: options.binding.sessionId, primeSessionFile: sessionFile });
    this.bindingDigest = digest({ sessionId: this.binding.sessionId, primeSessionFile: sessionFile });
    this.scanLimit = options.recoveryScanLimit ?? 128;
    this.maxObjectBytes = options.maxObjectBytes ?? 16 * 1024 * 1024;
    this.maxIndexBytes = options.maxIndexBytes ?? 64 * 1024 * 1024;
    this.maxStoreBytes = options.maxStoreBytes ?? 64 * 1024 * 1024;
    this.minFreeBytes = options.minFreeBytes ?? 128 * 1024 * 1024;
    this.retainGenerations = options.retainGenerations ?? 2;
    this.lockTimeout = options.lockTimeoutMs ?? 10_000;
    this.staleLock = options.staleLockMs ?? 120_000;
    this.fault = options.fault; this.now = options.now ?? Date.now;
    if (![this.scanLimit, this.maxObjectBytes, this.maxIndexBytes, this.maxStoreBytes, this.minFreeBytes, this.retainGenerations, this.lockTimeout, this.staleLock].every((v) => Number.isSafeInteger(v) && v > 0)) throw new Error("store limits must be positive integers");
    this.initialize();
  }

  private initialize(): void {
    privateDirectory(this.root);
    if (this.needsSchemaReset()) this.resetDerivedCache();
    for (const name of ["objects", "commits", "heads", "quarantine", "indexes"]) privateDirectory(join(this.root, name));
    const bindingPath = join(this.root, "BINDING");
    const value = `${canonical({ version: DURABLE_STORE_VERSION, ...this.binding, bindingDigest: this.bindingDigest })}\n`;
    if (existsSync(bindingPath)) {
      const stat = lstatSync(bindingPath);
      if (!stat.isFile() || stat.isSymbolicLink() || readFileSync(bindingPath, "utf8") !== value) {
        throw new Error("durable store is bound to another Prime session");
      }
    } else atomicWrite(bindingPath, value, false);
  }

  /** Unsupported derived schemas are disposable caches. User artifacts and grants are never touched. */
  private needsSchemaReset(): boolean {
    const bindingPath = join(this.root, "BINDING");
    // Pre-store context objects used snapshots/ + manifest.json without a
    // BINDING. V2 used bodies/. Both are disposable derived caches.
    if (existsSync(join(this.root, "snapshots")) || existsSync(join(this.root, "bodies"))) return true;
    if (!existsSync(bindingPath) && existsSync(join(this.root, "manifest.json"))) return true;
    if (existsSync(bindingPath)) {
      try {
        const binding = object(parseJson(bindingPath));
        if (binding?.version !== DURABLE_STORE_VERSION) return true;
      } catch { return true; }
    }
    const objectsPath = join(this.root, "objects");
    if (!existsSync(objectsPath)) return false;
    try {
      for (const name of requireDirectory(objectsPath)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        try { if (object(parseJson(join(objectsPath, name)))?.version !== DURABLE_OBJECT_VERSION) return true; }
        catch { /* normal recovery skips corrupt current-schema cache objects */ }
      }
    } catch { return true; }
    return false;
  }

  private resetDerivedCache(): void {
    for (const name of ["heads", "commits", "objects", "bodies", "snapshots", "indexes"]) {
      rmSync(join(this.root, name), { recursive: true, force: true });
    }
    for (const name of requireDirectory(this.root)) {
      if (name === "BINDING" || name === "CURRENT" || name === "GENERATION" || name === "index.json" || name === "index.sqlite"
        || name === "manifest.json" || /^manifest-[A-Za-z0-9._-]+\.json$/.test(name)) {
        rmSync(join(this.root, name), { recursive: true, force: true });
      }
    }
    syncDirectory(this.root);
  }

  private currentCandidate(): string | undefined {
    const path = join(this.root, "CURRENT");
    try { const value = safeFileText(path).trim(); return SHA256.test(value) ? value : undefined; } catch { return undefined; }
  }

  private validate(commitDigest: string): RecoveredGeneration | undefined {
    if (!SHA256.test(commitDigest)) return undefined;
    try {
      const commitPath = join(this.root, "commits", `${commitDigest}.json`); assertChild(this.root, commitPath);
      const commitRaw = safeFileText(commitPath).trim();
      if (createHash("sha256").update(commitRaw).digest("hex") !== commitDigest) return undefined;
      const c = object(JSON.parse(commitRaw));
      if (!c || c.version !== DURABLE_COMMIT_VERSION || c.bindingDigest !== this.bindingDigest || !safeInteger(c.generation)
        || typeof c.object !== "string" || !SHA256.test(c.object) || typeof c.sourceDigest !== "string" || typeof c.effectiveDigest !== "string"
        || !SHA256.test(c.sourceDigest) || !SHA256.test(c.effectiveDigest) || typeof c.converterVersion !== "string" || !c.converterVersion
        || typeof c.schemaVersion !== "string" || !c.schemaVersion || (c.mode !== "append" && c.mode !== "rebuild")
        || !Number.isSafeInteger(c.commonPrefix) || (c.parent !== null && (typeof c.parent !== "string" || !SHA256.test(c.parent)))) return undefined;
      const objectPath = join(this.root, "objects", `${c.object}.json`); assertChild(this.root, objectPath);
      const objectRaw = safeFileText(objectPath).trim();
      if (createHash("sha256").update(objectRaw).digest("hex") !== c.object) return undefined;
      const o = object(JSON.parse(objectRaw));
      if (!o || o.version !== DURABLE_OBJECT_VERSION || o.bindingDigest !== this.bindingDigest
        || o.sourceDigest !== c.sourceDigest || o.effectiveDigest !== c.effectiveDigest
        || !Array.isArray(o.sourceEntryDigests) || !Array.isArray(o.effectiveEntryDigests) || !object(o.compatibility)) return undefined;
      const sourceEntryDigests = o.sourceEntryDigests as unknown[];
      const effectiveEntryDigests = o.effectiveEntryDigests as unknown[];
      if (!sourceEntryDigests.every((item) => typeof item === "string" && SHA256.test(item))
        || !effectiveEntryDigests.every((item) => typeof item === "string" && SHA256.test(item))) return undefined;
      if ("effective" in o || !Array.isArray(o.sourceLocators) || !Array.isArray(o.effectiveReferences)
        || o.sourceLocators.length !== sourceEntryDigests.length || o.effectiveReferences.length !== effectiveEntryDigests.length) return undefined;
      const source: Json[] = []; const fd = openSync(this.binding.primeSessionFile, constants.O_RDONLY);
      try {
        const file = fstatSync(fd);
        for (let index = 0; index < o.sourceLocators.length; index++) {
          const locator = object(o.sourceLocators[index]);
          if (!locator || locator.index !== index || !Number.isSafeInteger(locator.byteOffset) || (locator.byteOffset as number) < 0
            || !safeInteger(locator.byteLength) || !safeInteger(locator.line) || locator.entryDigest !== sourceEntryDigests[index]
            || (locator.entryId !== undefined && typeof locator.entryId !== "string")) return undefined;
          const start = Number(locator.byteOffset), end = start + Number(locator.byteLength);
          if (end > file.size || (start > 0 && readRange(fd, start - 1, 1)[0] !== 0x0a)) return undefined;
          if (end < file.size) {
            const boundary = readRange(fd, end, Math.min(2, file.size - end));
            if (boundary[0] !== 0x0a && !(boundary[0] === 0x0d && boundary[1] === 0x0a)) return undefined;
          }
          const value = JSON.parse(readRange(fd, start, Number(locator.byteLength)).toString("utf8")) as Json;
          if (digest(value) !== locator.entryDigest) return undefined;
          const valueId = object(value)?.id;
          if (locator.entryId !== undefined && valueId !== locator.entryId) return undefined;
          source.push(value);
        }
      } finally { closeSync(fd); }
      if (digest(source) !== o.sourceDigest) return undefined;
      for (let index = 0; index < o.effectiveReferences.length; index++) {
        const reference = object(o.effectiveReferences[index]);
        if (!reference || reference.entryDigest !== effectiveEntryDigests[index]
          || (reference.sourceIndex !== null && (!Number.isSafeInteger(reference.sourceIndex) || (reference.sourceIndex as number) < 0 || (reference.sourceIndex as number) >= source.length))
          || (reference.role !== undefined && typeof reference.role !== "string")) return undefined;
      }
      const compatibility = object(o.compatibility);
      if (!compatibility || compatibility.version !== DURABLE_STORE_VERSION || compatibility.sessionId !== this.binding.sessionId
        || typeof compatibility.branchId !== "string" || compatibility.branchId.length === 0 || compatibility.branchId.length > 512
        || compatibility.revision !== c.generation || compatibility.messageCount !== effectiveEntryDigests.length || !Array.isArray(compatibility.entries) || compatibility.entries.length !== 0
        || compatibility.messages !== undefined
        || typeof compatibility.cropped !== "boolean" || compatibility.sourceDigest !== c.sourceDigest || compatibility.effectiveDigest !== c.effectiveDigest
        || compatibility.converterVersion !== c.converterVersion || compatibility.schemaVersion !== c.schemaVersion
        || typeof c.observedAt !== "number" || !Number.isFinite(c.observedAt) || c.observedAt < 0
        || (c.commonPrefix as number) < 0 || (c.commonPrefix as number) > sourceEntryDigests.length) return undefined;
      return { commitDigest, commit: c as unknown as DerivedCommit, object: o as unknown as DerivedObject };
    } catch { return undefined; }
  }

  private headGenerationNumbers(): number[] {
    try { return requireDirectory(join(this.root, "heads")).flatMap(name => /^([0-9]{16})-[a-f0-9]{64}$/.exec(name)?.[1]).map(Number).filter(Number.isSafeInteger); }
    catch { return []; }
  }

  private recoveredGenerations(): RecoveredGeneration[] {
    const names = (() => { try { return requireDirectory(join(this.root, "heads")); } catch { return []; } })()
      .filter(name => /^\d{16}-[a-f0-9]{64}$/.test(name)).sort().reverse();
    const values: RecoveredGeneration[] = [];
    for (const name of names) try {
      const digestValue = name.slice(17); if (safeFileText(join(this.root, "heads", name), 1024).trim() !== digestValue) continue;
      const value = this.validate(digestValue); if (value && value.commit.generation === Number(name.slice(0, 16))) { values.push(value); if (values.length >= this.scanLimit) break; }
    } catch { /* skip poisoned head */ }
    return values;
  }

  /** CURRENT is tried only as an optimization. Immutable heads are the recovery authority. */
  recover(branchId?: string): RecoveredGeneration | undefined {
    const hinted = this.currentCandidate();
    const hintedGeneration = hinted ? this.validate(hinted) : undefined;
    let hint: RecoveredGeneration | undefined;
    if (hintedGeneration) {
      const head = join(this.root, "heads", `${String(hintedGeneration.commit.generation).padStart(16, "0")}-${hintedGeneration.commitDigest}`);
      try { if (safeFileText(head).trim() === hintedGeneration.commitDigest) hint = hintedGeneration; } catch { /* CURRENT is not authority */ }
    }
    const names = (() => { try { return requireDirectory(join(this.root, "heads")); } catch { return []; } })()
      .filter((name) => /^\d{16}-[a-f0-9]{64}$/.test(name)).sort().reverse();
    let best = hint && (!branchId || hint.object.compatibility.branchId === branchId) ? hint : undefined;
    for (const name of names) {
      const namedGeneration = Number(name.slice(0, 16));
      const namedDigest = name.slice(17);
      let headValid = false;
      try { headValid = safeFileText(join(this.root, "heads", name)).trim() === namedDigest; } catch { /* ignored corruption */ }
      const candidate = headValid ? this.validate(namedDigest) : undefined;
      if (candidate && candidate.commit.generation === namedGeneration && (!branchId || candidate.object.compatibility.branchId === branchId) && (!best || candidate.commit.generation > best.commit.generation)) best = candidate;
    }
    return best;
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const release = await this.acquire();
    try {
      this.cleanup();
      const current = this.recover();
      if (current) this.pruneGenerations(current.commitDigest);
      return this.publishLocked(input);
    } finally { release(); }
  }

  private writeImmutable(path: string, contents: string, syncAfter = true): void {
    if (existsSync(path)) {
      try { if (safeFileText(path) === contents) return; } catch { /* quarantine below */ }
      const quarantined = join(this.root, "quarantine", `${this.now()}-${randomBytes(8).toString("hex")}-${path.slice(path.lastIndexOf(sep) + 1)}`);
      renameSync(path, quarantined); syncDirectory(dirname(path)); syncDirectory(join(this.root, "quarantine"));
    }
    atomicWrite(path, contents, false, undefined, syncAfter);
  }

  private readPrimeIndex(): PrimeIndexCursor | undefined {
    const path = join(this.root, "indexes", "prime-jsonl.json");
    try {
      const raw = safeFileText(path, this.maxIndexBytes); const parsed = object(JSON.parse(raw));
      if (!parsed || parsed.version !== "prime-agent-dsh/prime-jsonl-index-v1" || parsed.bindingDigest !== this.bindingDigest
        || !object(parsed.identity) || !Number.isSafeInteger((parsed.identity as Record<string, unknown>).dev)
        || !Number.isSafeInteger((parsed.identity as Record<string, unknown>).ino)
        || !Number.isSafeInteger(parsed.byteOffset) || (parsed.byteOffset as number) < 0
        || !safeInteger(parsed.nextLine) || typeof parsed.mtimeMs !== "number" || !Number.isFinite(parsed.mtimeMs)
        || typeof parsed.sourceDigest !== "string" || !SHA256.test(parsed.sourceDigest)
        || !Array.isArray(parsed.entries) || !parsed.entries.every(validPrimeLine)
        || typeof parsed.checksum !== "string" || !SHA256.test(parsed.checksum)) return undefined;
      const { checksum, ...unsigned } = parsed;
      if (digest(unsigned) !== checksum || indexedDigest(parsed.entries) !== parsed.sourceDigest) return undefined;
      const entries = parsed.entries;
      let previousEnd = 0, previousLine = 0;
      for (const entry of entries) {
        if (entry.offset < previousEnd || entry.line <= previousLine || entry.offset + entry.length > Number(parsed.byteOffset)) return undefined;
        previousEnd = entry.offset + entry.length; previousLine = entry.line;
      }
      return parsed as unknown as PrimeIndexCursor;
    } catch { return undefined; }
  }

  private primeIndex(): { entries: PrimeLine[]; diagnostics: PrimeIndexDiagnostics } {
    const path = this.binding.primeSessionFile; const fd = openSync(path, constants.O_RDONLY);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || !Number.isSafeInteger(before.size)) throw new Error("unsafe or oversized Prime session file");
      const prior = this.readPrimeIndex();
      const identityMatches = !!prior && prior.identity.dev === before.dev && prior.identity.ino === before.ino;
      let mode: PrimeIndexDiagnostics["mode"] = "full", offset = 0, firstLine = 1, entries: PrimeLine[] = [];
      if (identityMatches && prior.byteOffset === before.size && prior.mtimeMs === before.mtimeMs) {
        const after = fstatSync(fd);
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          throw new Error("Prime JSONL changed while locators were built");
        }
        return { entries: prior.entries, diagnostics: { mode: "cache", bytesProcessed: 0, linesProcessed: 0 } };
      }
      if (identityMatches && prior.byteOffset < before.size) {
        const endedAtLineBoundary = prior.byteOffset === 0 || readRange(fd, prior.byteOffset - 1, 1)[0] === 0x0a;
        if (endedAtLineBoundary) { mode = "tail"; offset = prior.byteOffset; firstLine = prior.nextLine; entries = prior.entries.slice(); }
      }
      const raw = readRange(fd, offset, before.size - offset);
      const parsed = parsePrimeBytes(raw, offset, firstLine); entries.push(...parsed.entries);
      const after = fstatSync(fd);
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new Error("Prime JSONL changed while locators were built");
      }
      const unsigned = {
        version: "prime-agent-dsh/prime-jsonl-index-v1" as const, bindingDigest: this.bindingDigest,
        identity: { dev: before.dev, ino: before.ino }, byteOffset: before.size, nextLine: parsed.nextLine,
        mtimeMs: before.mtimeMs, sourceDigest: indexedDigest(entries), entries,
      };
      const cursor: PrimeIndexCursor = { ...unsigned, checksum: digest(unsigned) };
      const text = `${canonical(cursor)}\n`;
      if (Buffer.byteLength(text, "utf8") > this.maxIndexBytes) throw new DurablePublicationUnavailableError(`Prime JSONL index exceeds ${this.maxIndexBytes} bytes`);
      atomicWrite(join(this.root, "indexes", "prime-jsonl.json"), text, true);
      return { entries, diagnostics: { mode, bytesProcessed: raw.length, linesProcessed: parsed.entries.length } };
    } finally { closeSync(fd); }
  }

  private locateSource(source: readonly Json[]): { locators: SourceLocator[]; diagnostics: PrimeIndexDiagnostics } {
    let indexed = this.primeIndex();
    const locate = (): SourceLocator[] | undefined => {
      const used = new Set<number>(); const result: SourceLocator[] = [];
      for (let index = 0; index < source.length; index++) {
        const entry = source[index]!; const entryDigest = digest(entry); const entryRecord = object(entry);
        const entryId = typeof entryRecord?.id === "string" ? entryRecord.id : undefined;
        let found = -1;
        if (entryId !== undefined) found = indexed.entries.findIndex((line, n) => !used.has(n) && line.id === entryId && line.digest === entryDigest);
        if (found < 0) found = indexed.entries.findIndex((line, n) => !used.has(n) && line.digest === entryDigest);
        if (found < 0) return undefined;
        used.add(found); const line = indexed.entries[found];
        result.push({ index, byteOffset: line.offset, byteLength: line.length, line: line.line, entryDigest, ...(entryId === undefined ? {} : { entryId }) });
      }
      return result;
    };
    let locators = locate();
    if (!locators && indexed.diagnostics.mode !== "full") {
      try { unlinkSync(join(this.root, "indexes", "prime-jsonl.json")); } catch { /* absent index */ }
      indexed = this.primeIndex(); locators = locate();
    }
    if (!locators) throw new Error("source entry is not present in the bound Prime JSONL");
    return { locators, diagnostics: indexed.diagnostics };
  }

  private publishLocked(input: PublishInput): PublishResult {
    if (!input.converterVersion || !input.schemaVersion) throw new Error("converterVersion and schemaVersion are required");
    const source = input.source.map((item) => JSON.parse(canonical(item)) as Json);
    const effective = input.effective.map((item) => JSON.parse(canonical(item)) as Json);
    const sourceDigest = digest(source), effectiveDigest = digest(effective);
    const sourceEntryDigests = source.map(digest);
    const effectiveEntryDigests = effective.map(digest);
    const located = this.locateSource(source);
    const sourceLocators = located.locators;
    const allRecovered = this.recoveredGenerations();
    const branchId = input.branchId ?? "root";
    const isAncestor = (value: RecoveredGeneration): boolean => value.object.sourceEntryDigests.length <= sourceEntryDigests.length
      && value.object.effectiveEntryDigests.length <= effectiveEntryDigests.length
      && value.object.sourceEntryDigests.every((item, index) => item === sourceEntryDigests[index])
      && value.object.effectiveEntryDigests.every((item, index) => item === effectiveEntryDigests[index]);
    const ancestors = allRecovered.filter(isAncestor).sort((a, b) => b.object.sourceEntryDigests.length - a.object.sourceEntryDigests.length || b.commit.generation - a.commit.generation);
    const prior = ancestors[0] ?? allRecovered.find(value => value.object.compatibility.branchId === branchId);
    const highWaterPath = join(this.root, "GENERATION");
    let highWater = 0;
    try { const value = Number(safeFileText(highWaterPath, 128).trim()); if (Number.isSafeInteger(value) && value >= 0) highWater = value; } catch { /* migrate from pre-high-water stores */ }
    const nextGeneration = Math.max(highWater, 0, ...this.headGenerationNumbers()) + 1;
    const same = prior && prior.commit.sourceDigest === sourceDigest && prior.commit.effectiveDigest === effectiveDigest
      && prior.commit.converterVersion === input.converterVersion && prior.commit.schemaVersion === input.schemaVersion
      && prior.object.compatibility.branchId === branchId;
    if (same) return { ...prior, mode: "noop", publication: {
      source: { mode: "noop", reused: sourceEntryDigests.length, new: 0, reindexed: 0 },
      index: located.diagnostics,
      effective: { reused: effectiveEntryDigests.length, new: 0, reindexed: 0, rebuildReason: "none" },
    } };
    let prefix = 0;
    if (prior && prior.commit.converterVersion === input.converterVersion && prior.commit.schemaVersion === input.schemaVersion) {
      const old = prior.object.sourceEntryDigests;
      while (prefix < old.length && prefix < sourceEntryDigests.length && old[prefix] === sourceEntryDigests[prefix]) prefix++;
    }
    let effectivePrefix = 0;
    if (prior) {
      const oldEffective = prior.object.effectiveEntryDigests;
      while (effectivePrefix < oldEffective.length && effectivePrefix < effectiveEntryDigests.length && oldEffective[effectivePrefix] === effectiveEntryDigests[effectivePrefix]) effectivePrefix++;
    }
    const sourceAppend = !!prior && prefix === prior.object.sourceEntryDigests.length && sourceEntryDigests.length > prefix;
    const append = sourceAppend && effectivePrefix === prior.object.effectiveEntryDigests.length;
    const sourceCounts = reuseCounts(prior?.object.sourceEntryDigests ?? [], sourceEntryDigests);
    const effectiveCounts = reuseCounts(prior?.object.effectiveEntryDigests ?? [], effectiveEntryDigests);
    const effectiveReason: EffectiveProjectionRebuildReason = !prior ? "initial"
      : prior.commit.converterVersion !== input.converterVersion || prior.commit.schemaVersion !== input.schemaVersion ? "converter-change"
      : prefix < prior.object.sourceEntryDigests.length ? "source-diverged"
      : sourceAppend && effectivePrefix < prior.object.effectiveEntryDigests.length ? "source-append-effective-projection-change"
      : effectivePrefix < prior.object.effectiveEntryDigests.length ? "effective-diverged" : "none";
    const publication: PublicationDiagnostics = {
      source: { mode: sourceAppend ? "append" : "rebuild", ...sourceCounts },
      index: located.diagnostics,
      effective: { ...effectiveCounts, rebuildReason: effectiveReason },
    };
    // V3 stores only verified references into Prime JSONL. Compatibility input is
    // deliberately ignored because it may contain cropped copies of secret text.
    if (input.effectiveSourceIndexes && input.effectiveSourceIndexes.length !== effective.length) {
      throw new Error("effective source index count does not match effective messages");
    }
    const effectiveReferences: EffectiveReference[] = effective.map((entry, index) => {
      let sourceIndex = input.effectiveSourceIndexes?.[index] ?? null;
      if (sourceIndex !== null && (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= source.length)) {
        throw new Error(`invalid effective source index at ${index}`);
      }
      if (sourceIndex === null) {
        if (sourceEntryDigests[index] === effectiveEntryDigests[index]) sourceIndex = index;
        else if (source.length === effective.length) {
          const nested = object(source[index])?.message;
          if (nested !== undefined && digest(nested) === effectiveEntryDigests[index]) sourceIndex = index;
        } else {
          const exact = sourceEntryDigests.indexOf(effectiveEntryDigests[index]);
          if (exact >= 0) sourceIndex = exact;
        }
      }
      const role = object(entry)?.role;
      return { entryDigest: effectiveEntryDigests[index], sourceIndex, ...(typeof role === "string" ? { role } : {}) };
    });
    const metrics = input.compatibilityMetrics
      ? JSON.parse(canonical(input.compatibilityMetrics)) as Record<string, number>
      : undefined;
    const derived: DerivedObject = {
      version: DURABLE_OBJECT_VERSION, bindingDigest: this.bindingDigest, sourceDigest, effectiveDigest,
      sourceEntryDigests, effectiveEntryDigests, sourceLocators, effectiveReferences,
      compatibility: {
        version: DURABLE_STORE_VERSION, sessionId: this.binding.sessionId, branchId,
        revision: nextGeneration, messageCount: effective.length, entries: [], cropped: input.cropped === true,
        sourceDigest, effectiveDigest, converterVersion: input.converterVersion, schemaVersion: input.schemaVersion,
        ...(metrics ? { metrics } : {}),
      },
    };
    const objectText = canonical(derived);
    const objectBytes = Buffer.byteLength(objectText, "utf8") + 1;
    if (objectBytes > this.maxObjectBytes) throw new DurablePublicationUnavailableError(`derived context object exceeds ${this.maxObjectBytes} bytes`);
    this.assertPublicationCapacity(objectBytes + 16 * 1024);
    // Persist the allocation before any generation content. Gaps are safe and
    // ensure cleanup/corruption can never cause a generation identity rewind.
    atomicWrite(highWaterPath, `${nextGeneration}\n`, true);
    const objectDigest = createHash("sha256").update(objectText).digest("hex");
    this.writeImmutable(join(this.root, "objects", `${objectDigest}.json`), `${objectText}\n`); this.fault?.("object-durable");
    const commit: DerivedCommit = {
      version: DURABLE_COMMIT_VERSION, bindingDigest: this.bindingDigest, generation: nextGeneration,
      parent: prior?.commitDigest ?? null, object: objectDigest, sourceDigest, effectiveDigest,
      converterVersion: input.converterVersion, schemaVersion: input.schemaVersion, mode: append ? "append" : "rebuild",
      commonPrefix: prefix, observedAt: input.observedAt ?? 0, publication,
    };
    const commitText = canonical(commit), commitDigest = createHash("sha256").update(commitText).digest("hex");
    this.writeImmutable(join(this.root, "commits", `${commitDigest}.json`), `${commitText}\n`); this.fault?.("commit-durable");
    // Validate the complete reference candidate before publishing its immutable head.
    if (!this.validate(commitDigest)) throw new Error("candidate durable context generation failed validation");
    const generation = String(commit.generation).padStart(16, "0");
    this.writeImmutable(join(this.root, "heads", `${generation}-${commitDigest}`), `${commitDigest}\n`); this.fault?.("head-durable");
    atomicWrite(join(this.root, "CURRENT"), `${commitDigest}\n`, true, () => this.fault?.("current-temp-durable")); this.fault?.("current-replaced");
    this.pruneGenerations(commitDigest);
    return { commitDigest, commit, object: derived, mode: commit.mode, publication };
  }

  private managedBytes(path = this.root): number {
    let total = 0;
    for (const name of requireDirectory(path)) {
      if (name === "LOCK") continue;
      const child = join(path, name);
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) throw new DurablePublicationUnavailableError(`symlink is not allowed in durable store: ${child}`);
      if (stat.isDirectory()) total += this.managedBytes(child);
      else if (stat.isFile()) total += stat.size;
    }
    return total;
  }

  private assertPublicationCapacity(candidateBytes: number): void {
    const used = this.managedBytes();
    if (used + candidateBytes > this.maxStoreBytes) {
      throw new DurablePublicationUnavailableError(`durable context quota exceeded (${used + candidateBytes} > ${this.maxStoreBytes} bytes)`);
    }
    const fs = statfsSync(this.root);
    const free = Number(fs.bavail) * Number(fs.bsize);
    if (!Number.isFinite(free) || free - candidateBytes < this.minFreeBytes) {
      throw new DurablePublicationUnavailableError(`durable context publication requires ${this.minFreeBytes} bytes free after write`);
    }
  }

  /** Retire the oldest authoritative generations head-first. */
  private pruneGenerations(currentDigest: string): void {
    const heads = requireDirectory(join(this.root, "heads"))
      .filter((name) => /^\d{16}-[a-f0-9]{64}$/.test(name)).sort().reverse();
    const observedHighWater = heads.reduce((maximum, name) => Math.max(maximum, Number(name.slice(0, 16))), 0);
    const highWaterPath = join(this.root, "GENERATION");
    let recordedHighWater = 0;
    try { recordedHighWater = Number(safeFileText(highWaterPath, 128).trim()) || 0; } catch { /* migration */ }
    if (observedHighWater > recordedHighWater) atomicWrite(highWaterPath, `${observedHighWater}\n`, true);
    const keep = new Set<string>([currentDigest]);
    for (const name of heads) {
      if (keep.size >= this.retainGenerations) break;
      const digestValue = name.slice(17);
      if (this.validate(digestValue)) keep.add(digestValue);
    }
    for (const name of heads) {
      const digestValue = name.slice(17);
      if (keep.has(digestValue)) continue;
      try { unlinkSync(join(this.root, "heads", name)); } catch { /* best effort; retry next publication */ }
    }
    syncDirectory(join(this.root, "heads"));
    const objects = new Set<string>();
    for (const name of requireDirectory(join(this.root, "commits"))) {
      const match = /^([a-f0-9]{64})\.json$/.exec(name);
      if (!match) continue;
      const commitDigest = match[1] ?? "";
      const path = join(this.root, "commits", name);
      if (!keep.has(commitDigest)) { try { unlinkSync(path); } catch { /* best effort */ } continue; }
      try { const value = object(parseJson(path)); if (typeof value?.object === "string" && SHA256.test(value.object)) objects.add(value.object); } catch { /* retained corrupt commit has no object authority */ }
    }
    for (const name of requireDirectory(join(this.root, "objects"))) {
      const match = /^([a-f0-9]{64})\.json$/.exec(name);
      if (match && !objects.has(match[1] ?? "")) try { unlinkSync(join(this.root, "objects", name)); } catch { /* best effort */ }
    }
    syncDirectory(join(this.root, "commits")); syncDirectory(join(this.root, "objects"));
    // Compatibility manifests are also rebuildable derived state. Retire only
    // names from this store's strict manifest namespace.
    for (const name of requireDirectory(this.root)) {
      const immutable = /^manifest-[a-f0-9]{64}-([a-f0-9]{64})\.json$/.exec(name);
      const branch = /^manifest-[a-f0-9]{64}\.json$/.exec(name);
      let remove = !!immutable && !keep.has(immutable[1] ?? "");
      if (branch) {
        try { const value = object(parseJson(join(this.root, name))); remove = typeof value?.commit !== "string" || !keep.has(value.commit); }
        catch { remove = true; }
      }
      if (remove) try { unlinkSync(join(this.root, name)); } catch { /* best effort */ }
    }
  }

  private async acquire(): Promise<() => void> {
    const path = join(this.root, "LOCK"); const deadline = this.now() + this.lockTimeout;
    for (;;) {
      try {
        mkdirSync(path, { mode: 0o700 });
        writeFileSync(join(path, "owner.json"), canonical({ pid: process.pid, started: this.now(), nonce: randomBytes(16).toString("hex") }), { flag: "wx", mode: 0o600 });
        syncDirectory(this.root);
        return () => { try { rmSync(path, { recursive: true, force: true }); syncDirectory(this.root); } catch { /* process exit also releases by staleness */ } };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        this.breakStaleLock(path);
        if (this.now() >= deadline) throw new Error("timed out acquiring durable context store lock", { cause: error });
        await sleep(10 + Math.floor(Math.random() * 20));
      }
    }
  }
  private breakStaleLock(path: string): void {
    try {
      const age = this.now() - lstatSync(path).mtimeMs; if (age < this.staleLock) return;
      const owner = object(parseJson(join(path, "owner.json"))); const pid = owner?.pid;
      if (typeof pid === "number" && Number.isSafeInteger(pid)) {
        try { process.kill(pid, 0); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return; }
      }
      renameSync(path, join(this.root, `quarantine`, `stale-lock-${this.now()}-${randomBytes(4).toString("hex")}`)); syncDirectory(this.root);
    } catch { /* another process won, or the lock cannot safely be proven stale */ }
  }
  private cleanup(): void {
    const cutoff = this.now() - this.staleLock;
    for (const directory of [this.root, join(this.root, "objects"), join(this.root, "commits"), join(this.root, "heads")]) {
      for (const name of requireDirectory(directory)) {
        if (!name.startsWith(".tmp-")) continue;
        const path = join(directory, name);
        try { if (lstatSync(path).mtimeMs < cutoff) unlinkSync(path); } catch { /* best effort */ }
      }
    }
    // A crash can leave a durable object or commit before its immutable head.
    // Only collect files older than the stale window while holding the writer lock.
    const headed = new Set(requireDirectory(join(this.root, "heads"))
      .filter((name) => /^\d{16}-[a-f0-9]{64}$/.test(name)).map((name) => name.slice(17)));
    const referencedObjects = new Set<string>();
    for (const name of requireDirectory(join(this.root, "commits"))) {
      const match = /^([a-f0-9]{64})\.json$/.exec(name); if (!match) continue;
      const path = join(this.root, "commits", name);
      if (!headed.has(match[1] ?? "")) {
        try { if (lstatSync(path).mtimeMs < cutoff) unlinkSync(path); } catch { /* best effort */ }
        continue;
      }
      try { const value = object(parseJson(path)); if (typeof value?.object === "string" && SHA256.test(value.object)) referencedObjects.add(value.object); } catch { /* corrupt commits are ignored */ }
    }
    for (const name of requireDirectory(join(this.root, "objects"))) {
      const match = /^([a-f0-9]{64})\.json$/.exec(name); if (!match || referencedObjects.has(match[1] ?? "")) continue;
      const path = join(this.root, "objects", name);
      try { if (lstatSync(path).mtimeMs < cutoff) unlinkSync(path); } catch { /* best effort */ }
    }
    const quarantine = requireDirectory(join(this.root, "quarantine")).sort().reverse();
    for (const name of quarantine.slice(8)) try { rmSync(join(this.root, "quarantine", name), { recursive: true, force: true }); } catch { /* best effort */ }
    syncDirectory(join(this.root, "objects")); syncDirectory(join(this.root, "commits")); syncDirectory(join(this.root, "quarantine"));
  }
}

function requireDirectory(path: string): string[] {
  const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe durable store directory: ${path}`);
  return readdirSync(path);
}
