import { Context } from "@deepseek-ai/cordis";
import type { FileAttachmentRef } from "@deepseek-ai/dsh-attachment";
import { LocalAttachmentStore } from "@deepseek-ai/dsh-attachment-local";
import { lstat, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const ID = /^sha256:([a-f0-9]{64})$/;

export interface DurableFileAttachmentOptions {
  /** Dedicated DSH home. DSH stores files below attachments/v1. */
  readonly dshHome: string;
  readonly maxObjectBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxObjects?: number;
}

export interface AttachmentUsage { readonly objects: number; readonly bytes: number }
export interface AttachmentCleanupResult extends AttachmentUsage { readonly removedObjects: number; readonly removedBytes: number }

/**
 * Provider-neutral durable files backed by DSH 0.1.6's verbatim attachment
 * primitives. References contain no model, message, or tool owner.
 */
export class DurableFileAttachments {
  readonly store: LocalAttachmentStore;
  private readonly maxObjectBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxObjects: number;
  private operation: Promise<void> = Promise.resolve();

  constructor(options: DurableFileAttachmentOptions) {
    if (!isAbsolute(options.dshHome)) throw new Error("dshHome must be absolute");
    this.maxObjectBytes = positive(options.maxObjectBytes ?? 64 * 1024 * 1024, "maxObjectBytes");
    this.maxTotalBytes = positive(options.maxTotalBytes ?? 512 * 1024 * 1024, "maxTotalBytes");
    this.maxObjects = positive(options.maxObjects ?? 10_000, "maxObjects");
    this.store = new LocalAttachmentStore(new Context(), { dshHome: options.dshHome });
  }

  async save(data: Uint8Array, name = "attachment.bin"): Promise<FileAttachmentRef> {
    if (data.byteLength > this.maxObjectBytes) throw new Error("attachment exceeds maxObjectBytes");
    return this.exclusive(async () => {
      const digest = await sha256(data);
      const usage = await this.usage();
      const duplicate = await this.objectExists(digest);
      if (!duplicate && (usage.objects >= this.maxObjects || usage.bytes + data.byteLength > this.maxTotalBytes)) {
        throw new Error("attachment quota exceeded");
      }
      return this.store.saveFile({ data, name });
    });
  }

  /** Read only after DSH verifies both byte length and sha256 digest. */
  async read(ref: FileAttachmentRef, signal?: AbortSignal): Promise<Uint8Array> {
    await this.assertSafeLocator(ref);
    if (ref.bytes > this.maxObjectBytes) throw new Error("attachment exceeds maxObjectBytes");
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of this.store.readFileStream(ref, signal)) { size += chunk.byteLength; if (size > this.maxObjectBytes || size > ref.bytes) throw new Error("attachment read exceeds declared bound"); chunks.push(chunk); }
    if (size !== ref.bytes) throw new Error("attachment byte length mismatch");
    const value = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.byteLength; }
    return value;
  }

  async *readStream(ref: FileAttachmentRef, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    await this.assertSafeLocator(ref); if (ref.bytes > this.maxObjectBytes) throw new Error("attachment exceeds maxObjectBytes");
    let size = 0; for await (const chunk of this.store.readFileStream(ref, signal)) { size += chunk.byteLength; if (size > this.maxObjectBytes || size > ref.bytes) throw new Error("attachment stream exceeds declared bound"); yield chunk; }
    if (size !== ref.bytes) throw new Error("attachment byte length mismatch");
  }

  /** Absolute read-only host locator. Invalid/traversing references are rejected by DSH. */
  hostPath(ref: FileAttachmentRef): string {
    return this.store.fileHostPath(ref);
  }

  async usage(): Promise<AttachmentUsage> {
    const root = join(this.store.root, "file-objects");
    let objects = 0; let bytes = 0;
    for (const path of await objectPaths(root)) {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe attachment object: ${path}`);
      objects++; bytes += stat.size;
    }
    return { objects, bytes };
  }

  /**
   * Delete generic files not present in `retain`. Callers pass all live durable
   * references. Image objects are never touched. Unsafe links abort cleanup.
   */
  async cleanup(retain: readonly FileAttachmentRef[]): Promise<AttachmentCleanupResult> {
    return this.exclusive(async () => {
      const keep = new Set(retain.map(digestOf));
      const root = join(this.store.root, "file-objects");
      let removedObjects = 0; let removedBytes = 0;
      for (const path of await objectPaths(root)) {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe attachment object: ${path}`);
        const digest = path.slice(path.lastIndexOf("/") + 1);
        if (!keep.has(digest)) {
          const aliases = join(this.store.root, "files", digest.slice(0, 2), digest);
          await assertSafeTree(aliases);
          await rm(path); removedObjects++; removedBytes += stat.size;
          // Aliases are hard links, but may use many safe display names.
          await rm(aliases, { recursive: true, force: true });
        }
      }
      const usage = await this.usage();
      return { ...usage, removedObjects, removedBytes };
    });
  }

  private async assertSafeLocator(ref: FileAttachmentRef): Promise<void> {
    digestOf(ref);
    const root = this.store.root;
    const path = this.store.fileHostPath(ref);
    const rel = relative(root, path); if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("attachment path escapes root");
    const rootStat = await lstat(root); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("unsafe attachment root");
    for (let cursor = path; cursor !== root; cursor = dirname(cursor)) {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed in attachment path: ${cursor}`);
      if (cursor === path && !stat.isFile()) throw new Error("attachment locator is not a file");
      if (dirname(cursor) === cursor) throw new Error("attachment path escapes root");
    }
  }

  private async objectExists(digest: string): Promise<boolean> {
    try {
      const stat = await lstat(join(this.store.root, "file-objects", digest.slice(0, 2), digest));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe attachment object");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const prior = this.operation; let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await work(); } finally { release(); }
  }
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
function digestOf(ref: FileAttachmentRef): string {
  const match = ID.exec(String(ref.attachmentId));
  if (!match || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new Error("invalid attachment reference");
  return match[1];
}
async function sha256(data: Uint8Array): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(data).digest("hex");
}
async function objectPaths(root: string): Promise<string[]> {
  let buckets;
  try { buckets = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const result: string[] = [];
  for (const bucket of buckets) {
    if (!bucket.isDirectory() || bucket.isSymbolicLink() || !/^[a-f0-9]{2}$/.test(bucket.name)) throw new Error("unsafe attachment object directory");
    for (const item of await readdir(join(root, bucket.name), { withFileTypes: true })) {
      if (!item.isFile() || item.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(item.name) || !item.name.startsWith(bucket.name)) throw new Error("unsafe attachment object entry");
      result.push(join(root, bucket.name, item.name));
    }
  }
  return result;
}

async function assertSafeTree(root: string): Promise<void> {
  let entries;
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe attachment alias directory: ${root}`);
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`unsafe attachment alias: ${entry.name}`);
  }
}
