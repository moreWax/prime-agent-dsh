import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { ContextService } from "./dsh-context-service.js";
import { ContextProtocolClient, type BranchKey } from "./context-protocol.js";
import { primeToDshAsync, dshToPrimeAsync, type PrimeMessage } from "./context-converter.js";
import { stableJson } from "./prefix-metrics.js";
import { LocalDshImageAttachments, type DshImageAttachmentGateway } from "./dsh-image-attachments.js";

export type ProjectionPromotionMode = "shadow" | "canary" | "active";
export type ProjectionFallbackReason =
  | "shadow-mode"
  | "canary-not-selected"
  | "sync-failed"
  | "project-failed"
  | "invalid-projection"
  | "round-trip-mismatch"
  | "exception";
export type ProjectionOutcome =
  | { selected: true; mode: "canary" | "active"; reason: "full-round-trip-parity"; context: Context; revision: number; messageCount: number }
  | { selected: false; mode: ProjectionPromotionMode; reason: ProjectionFallbackReason; context: Context };
export interface ProjectionPromotionOptions {
  mode?: ProjectionPromotionMode;
  /** Canary admission is deliberately separate from the mode flag. */
  selectCanary?: (key: BranchKey) => boolean;
}
export interface ShadowProjectionStats { syncs: number; skips: number; errors: number; promotions: number; lastMessageCount?: number; lastOutcome?: ProjectionOutcome }

const primeMessage = (value: unknown): PrimeMessage => {
  if (typeof value !== "object" || value === null || !("role" in value) || typeof value.role !== "string") throw new TypeError("invalid Prime message");
  return value as PrimeMessage;
};
const validMode = (value: string | undefined): ProjectionPromotionMode => {
  if (value === undefined || value === "") return "shadow";
  if (value === "shadow" || value === "canary" || value === "active") return value;
  throw new Error("PRIME_DSH_PROJECTION_MODE must be shadow, canary, or active");
};
export function projectionPromotionMode(env: NodeJS.ProcessEnv = process.env): ProjectionPromotionMode {
  return validMode(env.PRIME_DSH_PROJECTION_MODE);
}

export class DshContextShadow {
  private readonly client: ContextProtocolClient;
  private readonly revisions = new Map<string, number>();
  readonly mode: ProjectionPromotionMode;
  private readonly selectCanary: (key: BranchKey) => boolean;
  readonly stats: ShadowProjectionStats = { syncs: 0, skips: 0, errors: 0, promotions: 0 };

  constructor(
    service = new ContextService(),
    private readonly attachments: DshImageAttachmentGateway = new LocalDshImageAttachments(),
    options: ProjectionPromotionOptions = {},
  ) {
    this.mode = options.mode ?? projectionPromotionMode();
    this.selectCanary = options.selectCanary ?? (() => false);
    this.client = new ContextProtocolClient(request => service.handle(request));
    const initialized = this.client.call("initialize");
    if (!initialized.ok) throw new Error(initialized.error.message);
  }

  /** Evaluate the projection gate. Every failure returns the exact input object. */
  async project(context: Context, _model: Model<Api>, key: BranchKey = { sessionId: "provider-call", branchId: "root" }): Promise<ProjectionOutcome> {
    const encoded = JSON.stringify([key.sessionId, key.branchId]);
    try {
      const canonical = await Promise.all(context.messages.map((message, index) => primeToDshAsync(
        primeMessage(message),
        { admitImages: images => this.attachments.admitPrimeImages(images) },
        `prime-${createHash("sha256").update(`${index}:`).update(stableJson(message)).digest("hex").slice(0, 32)}`,
      )));
      const synced = this.client.call("session/sync-canonical", { key, messages: canonical, expectedRevision: this.revisions.get(encoded) ?? 0 });
      if (!synced.ok) return this.fallback(context, "sync-failed", true);
      const projected = this.client.call("project", { key });
      if (!projected.ok) return this.fallback(context, "project-failed", true);
      if (projected.result.revision !== synced.result.revision || projected.result.from !== 0
        || projected.result.total !== context.messages.length || projected.result.messages.length !== context.messages.length) {
        return this.fallback(context, "invalid-projection", true);
      }
      const roundTrip = await Promise.all(projected.result.messages.map(message => dshToPrimeAsync(
        message, { resolveImage: attachment => this.attachments.resolveDshImage(attachment) },
      )));
      const candidate = { ...context, messages: roundTrip } as unknown as Context;
      // Promotion requires parity of the complete provider Context, not merely roles or text.
      if (!isDeepStrictEqual(candidate, context)) return this.fallback(context, "round-trip-mismatch");

      this.revisions.set(encoded, synced.result.revision);
      this.stats.syncs++;
      this.stats.lastMessageCount = synced.result.messageCount;
      if (this.mode === "shadow") return this.fallback(context, "shadow-mode", false);
      if (this.mode === "canary" && !this.selectCanary(key)) return this.fallback(context, "canary-not-selected", false);
      const outcome: ProjectionOutcome = { selected: true, mode: this.mode, reason: "full-round-trip-parity", context: candidate, revision: synced.result.revision, messageCount: synced.result.messageCount };
      this.stats.promotions++;
      this.stats.lastOutcome = outcome;
      return outcome;
    } catch {
      return this.fallback(context, "exception", true);
    }
  }

  async prepare(context: Context, model: Model<Api>, key?: BranchKey): Promise<Context> {
    return (await this.project(context, model, key)).context;
  }

  private fallback(context: Context, reason: ProjectionFallbackReason, error = false): ProjectionOutcome {
    if (error) this.stats.errors++; else this.stats.skips++;
    const outcome: ProjectionOutcome = { selected: false, mode: this.mode, reason, context };
    this.stats.lastOutcome = outcome;
    return outcome;
  }
}
