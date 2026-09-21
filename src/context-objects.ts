import { closeSync, chmodSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, sep } from "node:path";
import { sessionEntryToContextMessages, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { primeToDshAsync, type PrimeEnvelope, type PrimeMessage } from "./context-converter.js";
import { DurableContextStore, type PublishResult } from "./durable-context-store.js";
import { stableJson } from "./prefix-metrics.js";
import { LocalDshImageAttachments, type DshImageAttachmentGateway } from "./dsh-image-attachments.js";

export const CONTEXT_OBJECT_VERSION = "prime-agent-dsh/context-object-v1" as const;

type JsonObject = Record<string, unknown>;

export interface ContextObjectMetrics {
  readonly assistantMessages: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
}

export interface ContextObjectManifest {
  readonly version: typeof CONTEXT_OBJECT_VERSION;
  readonly sessionId: string;
  readonly branchId: string;
  readonly revision: number;
  readonly observedAt: number;
  readonly messageCount: number;
  readonly entryCount: number;
  readonly cropped: boolean;
  readonly syncMode: "append" | "noop" | "rebuild";
  readonly commonPrefixMessages: number;
  readonly metrics: ContextObjectMetrics;
  /** Digest of the immutable derived object. */
  readonly digest: string;
  /** Path to the current immutable v3 reference object. */
  readonly snapshot: string;
  readonly commit?: string;
  readonly sourceDigest?: string;
  readonly effectiveDigest?: string;
}

export interface ContextObjectSyncResult {
  readonly manifest: ContextObjectManifest;
  readonly root: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function metricsFromBranch(branch: readonly unknown[]): ContextObjectMetrics {
  const totals = { assistantMessages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
  for (const raw of branch) {
    if (!isObject(raw) || raw.type !== "message" || !isObject(raw.message) || raw.message.role !== "assistant") continue;
    const usage = isObject(raw.message.usage) ? raw.message.usage : undefined;
    if (!usage) continue;
    totals.assistantMessages++;
    totals.inputTokens += tokenCount(usage.input);
    totals.outputTokens += tokenCount(usage.output);
    totals.cacheReadTokens += tokenCount(usage.cacheRead);
    totals.cacheWriteTokens += tokenCount(usage.cacheWrite);
    totals.totalTokens += tokenCount(usage.totalTokens);
  }
  return totals;
}

function asPrimeInput(value: unknown): PrimeMessage | PrimeEnvelope {
  if (!isObject(value)) throw new TypeError("Prime context message must be an object");
  if (isObject(value.message) && typeof value.message.role === "string") return value as PrimeEnvelope;
  if (typeof value.role === "string") return value as PrimeMessage;
  throw new TypeError("Prime context message has no role");
}

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Context object root is not a private directory: ${path}`);
  chmodSync(path, 0o700);
}

function atomicPrivateWrite(path: string, content: string): void {
  const temp = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  chmodSync(path, 0o600);
  let directory: number | undefined;
  try { directory = openSync(dirname(path), constants.O_RDONLY); fsyncSync(directory); }
  finally { if (directory !== undefined) closeSync(directory); }
}

function effectiveSourceIndexes(rawBranch: readonly unknown[], messages: readonly unknown[]): Array<number | null> {
  const candidates: Array<{ sourceIndex: number; fingerprint: string }> = [];
  rawBranch.forEach((entry, sourceIndex) => {
    try {
      for (const message of sessionEntryToContextMessages(entry as SessionEntry)) {
        candidates.push({ sourceIndex, fingerprint: stableJson(message) });
      }
    } catch { /* unsupported/log-only entries do not enter model context */ }
  });
  let cursor = 0;
  return messages.map((message) => {
    const fingerprint = stableJson(message);
    let found = candidates.findIndex((candidate, index) => index >= cursor && candidate.fingerprint === fingerprint);
    if (found < 0) found = candidates.findIndex((candidate) => candidate.fingerprint === fingerprint);
    if (found < 0) return null;
    cursor = found + 1;
    return candidates[found]?.sourceIndex ?? null;
  });
}

/** Resolve the artifact directory shared with Prime's per-session Python kernel. */
export function contextObjectRoot(sessionId: string, sessionFile: string | undefined): string | undefined {
  if (!sessionFile || !/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) return undefined;
  const sessionDir = dirname(sessionFile);
  // RLM child JSONL files already live inside their inherited artifact tree and
  // PRIME_AGENT sets RLM_SESSION_DIR to that directory. Root sessions—including
  // custom --session-dir roots—use the sibling session-artifacts/<id> layout.
  if (sessionDir.split(sep).includes("session-artifacts")) return join(sessionDir, "dsh-context");
  return join(dirname(sessionDir), "session-artifacts", sessionId, "dsh-context");
}

/**
 * Maintains a rebuildable DSH projection and immutable filesystem snapshots.
 * Prime JSONL remains canonical; this store never edits Prime or DSH history.
 */
export class ContextObjectStore {
  constructor(private readonly attachments: DshImageAttachmentGateway = new LocalDshImageAttachments()) {}

  /** Recover the newest valid committed generation without trusting CURRENT or manifest.json. */
  recover(ctx: ExtensionContext): PublishResult | undefined {
    const binding = this.binding(ctx);
    if (!binding) return undefined;
    const recovered = new DurableContextStore(binding).recover();
    return recovered ? { ...recovered, mode: "noop" } : undefined;
  }

  async sync(ctx: ExtensionContext, inputMessages?: readonly unknown[]): Promise<ContextObjectSyncResult | undefined> {
    const binding = this.binding(ctx);
    if (!binding) return undefined;
    const { sessionId } = binding.binding;
    const { root } = binding;
    const branchId = ctx.sessionManager.getLeafId?.() ?? "root";
    const rawBranch = (ctx.sessionManager.getBranch?.() ?? []) as readonly unknown[];
    const messages = inputMessages ?? this.sessionMessages(ctx);
    const selectedMessages = messages;
    const canonical = await Promise.all(selectedMessages.map((message, index) => primeToDshAsync(
      asPrimeInput(message),
      { admitImages: (images) => this.attachments.admitPrimeImages(images) },
      `prime-${createHash("sha256").update(`${messages.length - selectedMessages.length + index}:`).update(stableJson(message)).digest("hex").slice(0, 32)}`,
    )));
    const metrics = metricsFromBranch(rawBranch);
    const store = new DurableContextStore(binding);
    const published = await store.publish({
      source: rawBranch,
      effective: canonical,
      effectiveSourceIndexes: effectiveSourceIndexes(rawBranch, messages),
      converterVersion: "prime-to-dsh-v2-reference",
      schemaVersion: CONTEXT_OBJECT_VERSION,
      branchId,
      observedAt: Date.now(),
      compatibilityMetrics: { ...metrics },
      cropped: selectedMessages.length !== messages.length,
    });
    const view = published.object.compatibility;
    const manifest: ContextObjectManifest = {
      version: CONTEXT_OBJECT_VERSION,
      sessionId,
      branchId: view.branchId,
      revision: published.commit.generation,
      observedAt: published.commit.observedAt,
      messageCount: view.messageCount,
      entryCount: published.object.sourceEntryDigests.length,
      cropped: view.cropped,
      syncMode: published.mode,
      commonPrefixMessages: published.commit.commonPrefix,
      metrics,
      digest: published.commit.object,
      snapshot: `objects/${published.commit.object}.json`,
      commit: published.commitDigest,
      sourceDigest: published.commit.sourceDigest,
      effectiveDigest: published.commit.effectiveDigest,
    };
    ensurePrivateDirectory(root);
    const branchKey = createHash("sha256").update(branchId).digest("hex");
    const immutableManifest = join(root, `manifest-${branchKey}-${published.commitDigest}.json`);
    if (!lstatExists(immutableManifest)) atomicPrivateWrite(immutableManifest, `${JSON.stringify(manifest)}\n`);
    atomicPrivateWrite(join(root, `manifest-${branchKey}.json`), `${JSON.stringify(manifest)}\n`);
    // Current-view pointer only. Authoritative readers pass an immutable digest or expected branch.
    atomicPrivateWrite(join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    return { manifest, root };
  }

  private sessionMessages(ctx: ExtensionContext): readonly unknown[] {
    const manager = ctx.sessionManager as typeof ctx.sessionManager & { buildSessionContext?: () => { messages?: readonly unknown[] } };
    try {
      const built = manager.buildSessionContext?.();
      return Array.isArray(built?.messages) ? built.messages : [];
    } catch {
      return [];
    }
  }

  private binding(ctx: ExtensionContext): ConstructorParameters<typeof DurableContextStore>[0] | undefined {
    const sessionId = ctx.sessionManager.getSessionId?.() ?? "";
    const primeSessionFile = ctx.sessionManager.getSessionFile?.();
    const root = contextObjectRoot(sessionId, primeSessionFile);
    if (!sessionId || !primeSessionFile || !root) return undefined;
    return { root, binding: { sessionId, primeSessionFile } };
  }
}
