import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { ContextService } from "./dsh-context-service.js";
import { PROTOCOL } from "./context-protocol.js";

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
      const messages: Array<{ role: "user" | "assistant"; content: string; provider?: string; model?: string }> = [];
      for (const message of context.messages) {
        if (message.role !== "user" && message.role !== "assistant") { this.stats.skips++; return context; }
        if (typeof message.content === "string") messages.push({ role: message.role, content: message.content });
        else {
          const blocks = message.content;
          if (!Array.isArray(blocks) || blocks.some((block) => block.type !== "text")) { this.stats.skips++; return context; }
          const content = blocks.map((block: any) => block.text).join("");
          messages.push(message.role === "assistant" ? { role: "assistant", content, provider: message.provider, model: message.model } : { role: "user", content });
        }
      }
      const response: any = this.call("session/sync", { sessionId: sessionKey, messages, expectedRevision: this.revisions.get(sessionKey) ?? 0 });
      if (!response.ok) { this.stats.errors++; return context; }
      this.revisions.set(sessionKey, response.result.revision); this.stats.syncs++; this.stats.lastMessageCount = response.result.messageCount;
    } catch { this.stats.errors++; }
    return context;
  }
  private call(method: string, params?: unknown): unknown { return this.service.handle({ version: PROTOCOL, id: ++this.requestId, method, params }); }
}
