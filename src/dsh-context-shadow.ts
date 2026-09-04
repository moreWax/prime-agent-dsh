import { createHash } from "node:crypto";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { ContextService } from "./dsh-context-service.js";
import { PROTOCOL, type Failure, type Success } from "./context-protocol.js";
import { primeToDsh, dshToPrime, type PrimeMessage } from "./context-converter.js";
import { stableJson } from "./prefix-metrics.js";

export interface ShadowProjectionStats { syncs: number; skips: number; errors: number; lastMessageCount?: number; }
export class DshContextShadow {
  private readonly service = new ContextService();
  private requestId = 0;
  private revisions = new Map<string, number>();
  readonly stats: ShadowProjectionStats = { syncs: 0, skips: 0, errors: 0 };
  constructor() { this.call("initialize"); }
  /** Mirror supported context through a real DSH Session, but return Prime's exact object for parity. */
  prepare(context: Context, _model: Model<Api>, sessionKey = "provider-call"): Promise<Context> {
    try {
      const canonical = context.messages.map((message, index) => primeToDsh(message as unknown as PrimeMessage, {}, `prime-${createHash("sha256").update(`${index}:`).update(stableJson(message)).digest("hex").slice(0, 32)}`));
      const response = this.call("session/sync-canonical", { sessionId: sessionKey, messages: canonical,
        expectedRevision: this.revisions.get(sessionKey) ?? 0 });
      if (!response.ok) { this.stats.errors++; return Promise.resolve(context); }
      const projection = this.call("project", { sessionId: sessionKey });
      if (!projection.ok) { this.stats.errors++; return Promise.resolve(context); }
      const projected = projection.result as { messages: Parameters<typeof dshToPrime>[0][] };
      const roundTrip = projected.messages.map((message) => dshToPrime(message));
      if (stableJson(roundTrip) !== stableJson(context.messages)) { this.stats.skips++; return Promise.resolve(context); }
      const synced = response.result as { revision: number; messageCount: number };
      this.revisions.set(sessionKey, synced.revision); this.stats.syncs++; this.stats.lastMessageCount = synced.messageCount;
    } catch { this.stats.skips++; }
    return Promise.resolve(context);
  }
  private call(method: string, params?: unknown): Success | Failure { return this.service.handle({ version: PROTOCOL, id: ++this.requestId, method, params }); }
}
