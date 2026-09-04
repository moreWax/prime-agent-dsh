/**
 * Stage 3 — full-fidelity resume seeding.
 *
 * When a Prime conversation resumes but its persisted DSH session is gone
 * (pool eviction, TTL, manual cleanup), rebuild the DSH session log from
 * Prime's canonical transcript instead of starting blank.
 *
 * Translation is pure and unit-tested. The live append is deliberately
 * best-effort and never fatal: if the host DSH session refuses seeding, we
 * fall back to a blank start (current behavior) rather than breaking the
 * conversation. Enable with `"resumeSeed": true` in ~/.prime/agent/dsh.json
 * (or PI_DSH_RESUME_SEED=1) until the live-test pass flips the default.
 */

export interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
}

/** Neutral DSH log event we produce (structural subset of Session.append input). */
export interface SeedLogEvent {
  type: "user/message" | "assistant/message";
  data: unknown;
}

/** Minimal structural face of a DSH session we can append to. */
export interface SeedableSession {
  append(event: SeedLogEvent, options: { surfaceOp: "append" }): void;
  readonly seq: number;
}

/** Flatten Prime context messages (any role/card shape) to surface text. */
export function toText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (!block || typeof block !== "object") return "";
      const b = block as { type?: unknown; text?: unknown; content?: unknown };
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "text" && typeof b.content === "string") return b.content;
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

/** Pure: Prime committed messages -> ordered neutral transcript. */
export function transcriptFromMessages(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const message of messages) {
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = toText(message.content).trim();
    if (!text) continue;
    out.push({ role, content: text });
  }
  return out;
}

/** Pure: append user/assistant transcript events in order. */
export function buildSeedEvents(messages: readonly TranscriptMessage[]): SeedLogEvent[] {
  const events: SeedLogEvent[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      events.push({
        type: "user/message",
        data: { content: [{ type: "text", text: message.content }], source: { kind: "user" } },
      });
    } else {
      events.push({
        type: "assistant/message",
        data: { turn: 0, step: 0, message: { content: [{ type: "text", text: message.content }], source: { provider: "external", model: "unknown" } } },
      });
    }
  }
  return events;
}

/** Best-effort: append the transcript into a live DSH session. Never throws. */
export function seedSession(
  session: SeedableSession,
  messages: readonly TranscriptMessage[],
): number {
  let appended = 0;
  try {
    for (const event of buildSeedEvents(messages)) {
      session.append(event, { surfaceOp: "append" });
      appended++;
    }
  } catch {
    // Host rejected seeding (format drift, loop ownership). Leave the session
    // blank rather than poisoning it; the conversation still starts fresh.
    return 0;
  }
  return appended;
}
