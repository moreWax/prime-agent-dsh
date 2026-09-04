import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import {
  PROTOCOL,
  type Failure,
  type InitializeResult,
  type MethodResult,
  type ProjectParams,
  type ProjectResult,
  type ProtocolErrorCode,
  type RequestEnvelope,
  type RequestId,
  type Response,
  type SessionSummary,
  type ShutdownResult,
  type SimpleMessage,
  type StatusResult,
  type Success,
  type SyncParams,
  type SyncResult,
} from "./protocol.js";

interface StoredSession { session: Session; revision: number }
type JsonObject = Record<string, unknown>;

export class ProtocolFault extends Error {
  constructor(readonly code: ProtocolErrorCode, message: string, readonly data?: unknown) {
    super(message);
    this.name = "ProtocolFault";
  }
}

const fault = (code: ProtocolErrorCode, message: string, data?: unknown): ProtocolFault =>
  new ProtocolFault(code, message, data);

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}
function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export class ProtocolValidator {
  request(raw: unknown): RequestEnvelope {
    const value = object(raw);
    if (!value) throw fault("INVALID_REQUEST", "request must be an object");
    if (value.version !== PROTOCOL) throw fault("UNSUPPORTED_VERSION", `expected ${PROTOCOL}`);
    if ((typeof value.id !== "string" && typeof value.id !== "number") || typeof value.method !== "string") {
      throw fault("INVALID_REQUEST", "id and method are required");
    }
    return { version: PROTOCOL, id: value.id, method: value.method, params: value.params };
  }

  syncParams(raw: unknown): SyncParams {
    const value = object(raw);
    if (!value || typeof value.sessionId !== "string" || !Array.isArray(value.messages)) {
      throw fault("INVALID_PARAMS", "session/sync requires sessionId and messages[]");
    }
    if (!value.sessionId) throw fault("INVALID_PARAMS", "sessionId must not be empty");
    if (value.expectedRevision !== undefined && !nonNegativeInteger(value.expectedRevision)) {
      throw fault("INVALID_PARAMS", "expectedRevision must be a non-negative integer");
    }
    const messages = value.messages.map((message, index) => this.message(message, index));
    return {
      sessionId: value.sessionId,
      messages,
      ...(value.expectedRevision === undefined ? {} : { expectedRevision: value.expectedRevision }),
    };
  }

  projectParams(raw: unknown): ProjectParams {
    const value = object(raw);
    if (!value || typeof value.sessionId !== "string") throw fault("INVALID_PARAMS", "project requires sessionId");
    if (value.from !== undefined && !nonNegativeInteger(value.from)) {
      throw fault("INVALID_PARAMS", "from and limit must be non-negative integers");
    }
    if (value.limit !== undefined && !nonNegativeInteger(value.limit)) {
      throw fault("INVALID_PARAMS", "from and limit must be non-negative integers");
    }
    return {
      sessionId: value.sessionId,
      ...(value.from === undefined ? {} : { from: value.from }),
      ...(value.limit === undefined ? {} : { limit: value.limit }),
    };
  }

  private message(raw: unknown, index: number): SimpleMessage {
    const value = object(raw);
    if (!value || (value.role !== "user" && value.role !== "assistant") || typeof value.content !== "string") {
      throw fault("INVALID_PARAMS", `invalid message at index ${index}`);
    }
    if (value.role === "user") {
      if (value.source !== undefined && typeof value.source !== "string") throw fault("INVALID_PARAMS", `invalid message at index ${index}`);
      return { role: "user", content: value.content, ...(value.source === undefined ? {} : { source: value.source }) };
    }
    if (value.provider !== undefined && typeof value.provider !== "string") throw fault("INVALID_PARAMS", `invalid message at index ${index}`);
    if (value.model !== undefined && typeof value.model !== "string") throw fault("INVALID_PARAMS", `invalid message at index ${index}`);
    return {
      role: "assistant", content: value.content,
      ...(value.provider === undefined ? {} : { provider: value.provider }),
      ...(value.model === undefined ? {} : { model: value.model }),
    };
  }
}

export class SessionState {
  private readonly sessions = new Map<string, StoredSession>();

  get(sessionId: string): StoredSession | undefined { return this.sessions.get(sessionId); }
  set(sessionId: string, state: StoredSession): void { this.sessions.set(sessionId, state); }
  revision(sessionId: string): number { return this.get(sessionId)?.revision ?? 0; }
  summaries(): SessionSummary[] {
    return [...this.sessions].map(([sessionId, state]) => ({
      sessionId,
      revision: state.revision,
      eventCount: state.session.seq,
      messageCount: state.session.deriveMessages().length,
    }));
  }
  status(initialized: boolean, shuttingDown: boolean): StatusResult {
    const sessions = this.summaries();
    return { initialized, shuttingDown, sessionCount: sessions.length, sessions };
  }
}

export class SessionReconciler {
  constructor(private readonly state: SessionState) {}

  sync(params: SyncParams): SyncResult {
    const actualRevision = this.state.revision(params.sessionId);
    if (params.expectedRevision !== undefined && params.expectedRevision !== actualRevision) {
      throw fault("REVISION_CONFLICT", "expectedRevision does not match", { actualRevision });
    }
    // Build independently, then publish: a failed append cannot mutate authoritative state.
    const session = Session.create(SessionId(params.sessionId));
    for (const input of params.messages) this.append(session, input);
    const revision = actualRevision + 1;
    this.state.set(params.sessionId, { session, revision });
    return { sessionId: params.sessionId, revision, eventCount: session.seq, messageCount: session.deriveMessages().length };
  }

  private append(session: Session, input: SimpleMessage): void {
    if (input.role === "user") {
      const message = createUserMessage({
        content: [{ type: "text", text: input.content }],
        source: input.source && input.source !== "user" ? { kind: "plugin", plugin: input.source } : { kind: "user" },
      });
      session.append("user/message", message, { surfaceOp: "append" });
      return;
    }
    const message = createAssistantMessage({
      content: [{ type: "text", text: input.content }],
      source: { provider: input.provider ?? "external", model: input.model ?? "unknown" },
    });
    session.append("assistant/message", { turn: 0, step: 0, message }, { surfaceOp: "append" });
  }
}

export class SessionProjector {
  constructor(private readonly state: SessionState) {}

  project(params: ProjectParams): ProjectResult {
    const state = this.state.get(params.sessionId);
    if (!state) throw fault("SESSION_NOT_FOUND", `unknown session: ${params.sessionId}`);
    const messages = state.session.deriveMessages();
    const from = params.from ?? 0;
    const limit = params.limit ?? messages.length;
    return { sessionId: params.sessionId, revision: state.revision, total: messages.length, from, messages: messages.slice(from, from + limit) };
  }
}

export class ContextService {
  private initialized = false;
  private stopping = false;
  private readonly state = new SessionState();
  private readonly validator = new ProtocolValidator();
  private readonly reconciler = new SessionReconciler(this.state);
  private readonly projector = new SessionProjector(this.state);

  constructor(private readonly onShutdown: () => void = () => {}) {}

  handle(raw: unknown): Response {
    let id: RequestId | null = null;
    try {
      const request = this.validator.request(raw);
      id = request.id;
      if (this.stopping && request.method !== "status") throw fault("SHUTTING_DOWN", "service is shutting down");
      return this.success(id, this.dispatch(request));
    } catch (error: unknown) {
      const protocolFault = error instanceof ProtocolFault
        ? error
        : fault("INTERNAL", error instanceof Error ? error.message : String(error));
      return {
        version: PROTOCOL, id, ok: false,
        error: { code: protocolFault.code, message: protocolFault.message, ...(protocolFault.data === undefined ? {} : { data: protocolFault.data }) },
      };
    }
  }

  private success(id: RequestId, result: MethodResult): Success {
    return { version: PROTOCOL, id, ok: true, result };
  }

  private dispatch(request: RequestEnvelope): MethodResult {
    if (request.method === "initialize") return this.initialize();
    if (!this.initialized) throw fault("NOT_INITIALIZED", "call initialize first");
    switch (request.method) {
      case "session/sync": return this.reconciler.sync(this.validator.syncParams(request.params));
      case "project": return this.projector.project(this.validator.projectParams(request.params));
      case "status": return this.state.status(true, this.stopping);
      case "shutdown": return this.shutdown();
      default: throw fault("METHOD_NOT_FOUND", `unknown method: ${request.method}`);
    }
  }

  private initialize(): InitializeResult {
    if (this.initialized) throw fault("ALREADY_INITIALIZED", "initialize may be called once");
    this.initialized = true;
    return {
      protocol: PROTOCOL,
      implementation: { name: "dsh-inference-context", version: "0.0.1" },
      capabilities: {
        transport: ["stdio", "socket"],
        methods: ["initialize", "session/sync", "project", "status", "shutdown"],
        dshSession: true,
        agentLoop: false,
      },
    };
  }

  private shutdown(): ShutdownResult {
    this.stopping = true;
    queueMicrotask(this.onShutdown);
    return { accepted: true };
  }
}
