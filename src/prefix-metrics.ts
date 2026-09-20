import { createHash } from "node:crypto";

export interface PrefixMeasurement {
  request: number;
  bytes: number;
  previousBytes: number;
  commonPrefixBytes: number;
  prefixRatio: number;
  digest: string;
  changedAt: number;
  reason: "initial" | "append" | "model-or-envelope" | "history-rewrite";
}

export function stableJson(value: unknown, sortKeys = true): string {
  const seen = new WeakSet<object>();
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") {
      if (seen.has(item)) throw new Error("cyclic provider payload");
      seen.add(item);
      const result: Record<string, unknown> = {};
      for (const key of (sortKeys ? Object.keys(item).sort() : Object.keys(item))) {
        if (/authorization|api[_-]?key|token|secret|password|cookie/i.test(key)) { result[key] = "[REDACTED]"; continue; }
        const value = (item as Record<string, unknown>)[key];
        if (value !== undefined) result[key] = visit(value);
      }
      return result;
    }
    return typeof item === "bigint" ? item.toString() : item;
  };
  return JSON.stringify(visit(value));
}

export function commonPrefixBytes(left: string, right: string): number {
  const a = Buffer.from(left), b = Buffer.from(right); const n = Math.min(a.length, b.length);
  let i = 0; while (i < n && a[i] === b[i]) i++; return i;
}

interface PrefixFingerprint {
  readonly bytes: number;
  readonly digest: string;
  /** Fixed-size chunk digests. They retain no provider or transcript text. */
  readonly chunks: readonly string[];
}

const PREFIX_CHUNK_BYTES = 256;

function fingerprint(value: string): PrefixFingerprint {
  const bytes = Buffer.from(value);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += PREFIX_CHUNK_BYTES) {
    chunks.push(createHash("sha256").update(bytes.subarray(offset, offset + PREFIX_CHUNK_BYTES)).digest("hex"));
  }
  return { bytes: bytes.length, digest: createHash("sha256").update(bytes).digest("hex"), chunks: Object.freeze(chunks) };
}

function measuredCommonPrefix(previous: PrefixFingerprint, currentText: string, current: PrefixFingerprint): number {
  const bytes = Buffer.from(currentText);
  // Exact append detection needs only the prior digest, not the prior content.
  if (bytes.length >= previous.bytes && createHash("sha256").update(bytes.subarray(0, previous.bytes)).digest("hex") === previous.digest) {
    return previous.bytes;
  }
  let chunks = 0;
  const complete = Math.floor(Math.min(previous.bytes, current.bytes) / PREFIX_CHUNK_BYTES);
  while (chunks < complete && previous.chunks[chunks] === current.chunks[chunks]) chunks++;
  // For rewrites this is a privacy-preserving lower bound, accurate to one chunk.
  return chunks * PREFIX_CHUNK_BYTES;
}

export class PrefixTracker {
  private previous?: PrefixFingerprint;
  private count = 0;
  constructor(private readonly sortKeys = true) {}
  measure(payload: unknown): PrefixMeasurement {
    const canonical = stableJson(payload, this.sortKeys);
    const current = fingerprint(canonical), previous = this.previous;
    const common = previous === undefined ? 0 : measuredCommonPrefix(previous, canonical, current);
    const bytes = current.bytes, previousBytes = previous?.bytes ?? 0;
    let reason: PrefixMeasurement["reason"] = "initial";
    if (previous !== undefined) {
      if (common === previousBytes || common / Math.max(1, previousBytes) >= 0.9) reason = "append";
      else if (common < Math.min(previousBytes, 1024)) reason = "model-or-envelope";
      else reason = "history-rewrite";
    }
    this.previous = current;
    return { request: ++this.count, bytes, previousBytes, commonPrefixBytes: common,
      prefixRatio: previousBytes === 0 ? 0 : common / previousBytes,
      digest: current.digest, changedAt: common, reason };
  }
  reset(): void { this.previous = undefined; this.count = 0; }
}
