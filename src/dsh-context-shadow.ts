import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { ContextService } from "./dsh-context-service.js";
import { PROTOCOL } from "./context-protocol.js";
import { primeToDsh, dshToPrime } from "./context-converter.js";

export interface ShadowProjectionStats { syncs: number; skips: number; errors: number; lastMessageCount?: number; }
export class DshContextShadow {
  private readonly service = new ContextService();
  private requestId = 0;
  private revisions = new Map<string, number>();
  readonly stats: ShadowProjectionStats = { syncs: 0, skips: 0, errors: 0 };
  constructor() { this.call("initialize"); }
  /** Mirror supported context through a real DSH Session, but return Prime's exact object for parity. */
  async prepare(context: Context, model: Model<Api>, sessionKey = "provider-call"): Promise<Context> {
    try {
      const canonical = context.messages.map((message) => primeToDsh(message as any));
      const response: any = this.call("session/sync-canonical", { sessionId: sessionKey, messages: canonical,
        expectedRevision: this.revisions.get(sessionKey) ?? 0 });
      if (!response.ok) { this.stats.errors++; return context; }
      const projection: any = this.call("project", { sessionId: sessionKey });
      if (!projection.ok) { this.stats.errors++; return context; }
      const roundTrip = projection.result.messages.map((message: any) => dshToPrime(message));
      if (JSON.stringify(roundTrip) !== JSON.stringify(context.messages)) { this.stats.skips++; return context; }
      this.revisions.set(sessionKey, response.result.revision); this.stats.syncs++; this.stats.lastMessageCount = response.result.messageCount;
    } catch { this.stats.skips++; }
    return context;
  }
  private call(method: string, params?: unknown): unknown { return this.service.handle({ version: PROTOCOL, id: ++this.requestId, method, params }); }
}
