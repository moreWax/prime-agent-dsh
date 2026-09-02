import { randomUUID } from "node:crypto";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createUserMessage, freezeMessage, type Message } from "@deepseek-ai/dsh-llm";
import { PROTOCOL, type Request, type Success, type Failure, type SimpleMessage } from "./context-protocol.js";

type State = { session: Session; revision: number };
type SyncParams = { sessionId: string; messages: SimpleMessage[]; expectedRevision?: number };
type ProjectParams = { sessionId: string; from?: number; limit?: number };
const own = (v: unknown, k: string): boolean => typeof v === "object" && v !== null && Object.hasOwn(v, k);

export class ContextService {
  private initialized = false;
  private stopping = false;
  private sessions = new Map<string, State>();
  constructor(private readonly onShutdown: () => void = () => {}) {}

  handle(raw: unknown): Success | Failure {
    let id: string | number | null = null;
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fault("INVALID_REQUEST", "request must be an object");
      const r = raw as Partial<Request>; id = typeof r.id === "string" || typeof r.id === "number" ? r.id : null;
      if (r.version !== PROTOCOL) throw fault("UNSUPPORTED_VERSION", `expected ${PROTOCOL}`);
      if (id === null || typeof r.method !== "string") throw fault("INVALID_REQUEST", "id and method are required");
      if (this.stopping && r.method !== "status") throw fault("SHUTTING_DOWN", "service is shutting down");
      const result = this.dispatch(r.method, r.params);
      return { version: PROTOCOL, id, ok: true, result };
    } catch (e) {
      const f = e instanceof ProtocolFault ? e : fault("INTERNAL", e instanceof Error ? e.message : String(e));
      return { version: PROTOCOL, id, ok: false, error: { code: f.code, message: f.message, ...(f.data === undefined ? {} : { data: f.data }) } };
    }
  }

  private dispatch(method: string, params: unknown): unknown {
    if (method === "initialize") {
      if (this.initialized) throw fault("ALREADY_INITIALIZED", "initialize may be called once");
      this.initialized = true;
      return { protocol: PROTOCOL, implementation: { name: "dsh-inference-context", version: "0.0.1" }, capabilities: { transport: ["stdio", "socket"], methods: ["initialize", "session/sync", "project", "status", "shutdown"], dshSession: true, agentLoop: false } };
    }
    if (!this.initialized) throw fault("NOT_INITIALIZED", "call initialize first");
    switch (method) {
      case "session/sync": return this.sync(assertSync(params));
      case "session/sync-canonical": return this.syncCanonical(assertCanonicalSync(params));
      case "project": return this.project(assertProject(params));
      case "status": return { initialized: true, shuttingDown: this.stopping, sessionCount: this.sessions.size, sessions: [...this.sessions].map(([sessionId, s]) => ({ sessionId, revision: s.revision, eventCount: s.session.seq, messageCount: s.session.deriveMessages().length })) };
      case "shutdown": this.stopping = true; queueMicrotask(this.onShutdown); return { accepted: true };
      default: throw fault("METHOD_NOT_FOUND", `unknown method: ${method}`);
    }
  }

  private sync(p: SyncParams): unknown {
    const prior = this.sessions.get(p.sessionId);
    if (p.expectedRevision !== undefined && p.expectedRevision !== (prior?.revision ?? 0)) throw fault("REVISION_CONFLICT", "expectedRevision does not match", { actualRevision: prior?.revision ?? 0 });
    // Rebuild from the authoritative client snapshot. DSH Session append owns validation,
    // event sequencing, immutable snapshots and canonical message derivation.
    const session = Session.create(SessionId(p.sessionId));
    for (const input of p.messages) {
      if (input.role === "user") {
        const msg = createUserMessage({ content: [{ type: "text", text: input.content }], source: input.source && input.source !== "user" ? { kind: "plugin", plugin: input.source } : { kind: "user" } });
        session.append("user/message", msg, { surfaceOp: "append" });
      } else {
        const msg = createAssistantMessage({ content: [{ type: "text", text: input.content }], source: { provider: input.provider ?? "external", model: input.model ?? "unknown" } });
        session.append("assistant/message", { turn: 0, step: 0, message: msg }, { surfaceOp: "append" });
      }
    }
    const revision = (prior?.revision ?? 0) + 1;
    this.sessions.set(p.sessionId, { session, revision });
    return { sessionId: p.sessionId, revision, eventCount: session.seq, messageCount: session.deriveMessages().length };
  }

  private syncCanonical(p: { sessionId: string; messages: Message[]; expectedRevision?: number }): unknown {
    const prior = this.sessions.get(p.sessionId);
    if (p.expectedRevision !== undefined && p.expectedRevision !== (prior?.revision ?? 0)) throw fault("REVISION_CONFLICT", "expectedRevision does not match", { actualRevision: prior?.revision ?? 0 });
    const session = Session.create(SessionId(p.sessionId));
    let step = 0;
    for (const raw of p.messages) {
      const message = freezeMessage(raw);
      if (message.role === "assistant") {
        session.append("assistant/message", { turn: step, step, message: message as any }, { surfaceOp: "append" });
      } else if (message.source.kind === "tool") {
        session.append("tool/result", { turn: step, step, message: message as any }, { surfaceOp: "append" });
      } else {
        session.append("user/message", message as any, { surfaceOp: "append" });
      }
      step++;
    }
    const revision = (prior?.revision ?? 0) + 1;
    this.sessions.set(p.sessionId, { session, revision });
    return { sessionId: p.sessionId, revision, eventCount: session.seq, messageCount: session.deriveMessages().length };
  }

  private project(p: ProjectParams): unknown {
    const state = this.sessions.get(p.sessionId); if (!state) throw fault("SESSION_NOT_FOUND", `unknown session: ${p.sessionId}`);
    const all = state.session.deriveMessages(); const from = p.from ?? 0; const limit = p.limit ?? all.length;
    if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(limit) || limit < 0) throw fault("INVALID_PARAMS", "from and limit must be non-negative integers");
    return { sessionId: p.sessionId, revision: state.revision, total: all.length, from, messages: all.slice(from, from + limit) };
  }
}
class ProtocolFault extends Error { constructor(readonly code: string, message: string, readonly data?: unknown) { super(message); } }
function fault(code: string, message: string, data?: unknown): ProtocolFault { return new ProtocolFault(code, message, data); }
function assertSync(v: unknown): SyncParams {
  if (!v || typeof v !== "object" || typeof (v as any).sessionId !== "string" || !Array.isArray((v as any).messages)) throw fault("INVALID_PARAMS", "session/sync requires sessionId and messages[]");
  const p = v as SyncParams; if (!p.sessionId) throw fault("INVALID_PARAMS", "sessionId must not be empty");
  if (p.expectedRevision !== undefined && (!Number.isSafeInteger(p.expectedRevision) || p.expectedRevision < 0)) throw fault("INVALID_PARAMS", "expectedRevision must be a non-negative integer");
  p.messages.forEach((m, i) => { if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") throw fault("INVALID_PARAMS", `invalid message at index ${i}`); }); return p;
}
function assertProject(v: unknown): ProjectParams {
  if (!v || typeof v !== "object" || typeof (v as any).sessionId !== "string") throw fault("INVALID_PARAMS", "project requires sessionId"); return v as ProjectParams;
}

function assertCanonicalSync(v: unknown): { sessionId: string; messages: Message[]; expectedRevision?: number } {
  if (!v || typeof v !== "object" || typeof (v as any).sessionId !== "string" || !Array.isArray((v as any).messages)) throw fault("INVALID_PARAMS", "session/sync-canonical requires sessionId and messages[]");
  return v as { sessionId: string; messages: Message[]; expectedRevision?: number };
}
