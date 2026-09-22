/** Provider cache accounting. Byte-prefix eligibility belongs in prefix-metrics, not here. */
export interface ProviderCacheSample {
  readonly request: number;
  readonly inputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}
export interface ProviderCachePoint extends ProviderCacheSample {
  /** null means the provider did not report enough data. */
  readonly efficiency: number | null;
}
export interface ProviderCacheAggregate {
  readonly requests: number;
  readonly reportedReadRequests: number;
  readonly reportedWriteRequests: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly inputTokens: number;
  readonly efficiency: number | null;
  readonly readP50: number | null;
  readonly readP90: number | null;
  readonly writeP50: number | null;
  readonly writeP90: number | null;
  readonly efficiencyP50: number | null;
  readonly efficiencyP90: number | null;
}
const valid = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1] ?? null;
}
export class ProviderCacheSeries {
  private readonly values: ProviderCachePoint[] = [];
  add(sample: ProviderCacheSample): ProviderCachePoint {
    if (!Number.isSafeInteger(sample.request) || sample.request <= 0) throw new TypeError("request must be a positive integer");
    for (const [key, value] of Object.entries(sample)) if (key !== "request" && value !== undefined && !valid(value)) throw new TypeError(`${key} must be non-negative`);
    const read = sample.cacheReadTokens, input = sample.inputTokens;
    const efficiency = valid(read) && valid(input) && input + read > 0 ? read / (input + read) : null;
    const point = Object.freeze({ ...sample, efficiency }); this.values.push(point); return point;
  }
  points(): readonly ProviderCachePoint[] { return Object.freeze([...this.values]); }
  aggregate(): ProviderCacheAggregate {
    const reads = this.values.flatMap(x => valid(x.cacheReadTokens) ? [x.cacheReadTokens] : []);
    const writes = this.values.flatMap(x => valid(x.cacheWriteTokens) ? [x.cacheWriteTokens] : []);
    const inputs = this.values.flatMap(x => valid(x.inputTokens) ? [x.inputTokens] : []);
    const cacheReadTokens = reads.reduce((a, b) => a + b, 0), inputTokens = inputs.reduce((a, b) => a + b, 0);
    return Object.freeze({ requests: this.values.length, reportedReadRequests: reads.length, reportedWriteRequests: writes.length,
      cacheReadTokens, cacheWriteTokens: writes.reduce((a, b) => a + b, 0), inputTokens,
      efficiency: reads.length && inputs.length && inputTokens + cacheReadTokens > 0 ? cacheReadTokens / (inputTokens + cacheReadTokens) : null,
      readP50: percentile(reads, .5), readP90: percentile(reads, .9),
      writeP50: percentile(writes, .5), writeP90: percentile(writes, .9),
      efficiencyP50: percentile(this.values.flatMap(x => x.efficiency === null ? [] : [x.efficiency]), .5),
      efficiencyP90: percentile(this.values.flatMap(x => x.efficiency === null ? [] : [x.efficiency]), .9) });
  }
}
