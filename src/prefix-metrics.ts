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
      for (const key of (sortKeys ? Object.keys(item as Record<string, unknown>).sort() : Object.keys(item as Record<string, unknown>))) {
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

export class PrefixTracker {
  private previous?: string;
  private count = 0;
  constructor(private readonly sortKeys = true) {}
  measure(payload: unknown): PrefixMeasurement {
    const canonical = stableJson(payload, this.sortKeys); const previous = this.previous;
    const common = previous === undefined ? 0 : commonPrefixBytes(previous, canonical);
    const bytes = Buffer.byteLength(canonical), previousBytes = previous === undefined ? 0 : Buffer.byteLength(previous);
    let reason: PrefixMeasurement["reason"] = "initial";
    if (previous !== undefined) {
      if (canonical.startsWith(previous) || common / Math.max(1, previousBytes) >= 0.9) reason = "append";
      else if (common < Math.min(previousBytes, 1024)) reason = "model-or-envelope";
      else reason = "history-rewrite";
    }
    this.previous = canonical;
    return { request: ++this.count, bytes, previousBytes, commonPrefixBytes: common,
      prefixRatio: previousBytes === 0 ? 0 : common / previousBytes,
      digest: createHash("sha256").update(canonical).digest("hex"), changedAt: common, reason };
  }
  reset(): void { this.previous = undefined; this.count = 0; }
}
