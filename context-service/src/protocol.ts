export const PROTOCOL = "dsh-context/1" as const;

export type RequestId = string | number;
export type UserInputMessage = {
  role: "user";
  content: string;
  source?: string;
};
export type AssistantInputMessage = {
  role: "assistant";
  content: string;
  provider?: string;
  model?: string;
};
export type SimpleMessage = UserInputMessage | AssistantInputMessage;

export interface SyncParams {
  sessionId: string;
  messages: SimpleMessage[];
  expectedRevision?: number;
}
export interface ProjectParams {
  sessionId: string;
  from?: number;
  limit?: number;
}

interface RequestBase<M extends string, P> {
  version: typeof PROTOCOL;
  id: RequestId;
  method: M;
  params: P;
}
export type InitializeRequest = RequestBase<"initialize", unknown>;
export type SyncRequest = RequestBase<"session/sync", SyncParams>;
export type ProjectRequest = RequestBase<"project", ProjectParams>;
export type StatusRequest = RequestBase<"status", unknown>;
export type ShutdownRequest = RequestBase<"shutdown", unknown>;
export type Request = InitializeRequest | SyncRequest | ProjectRequest | StatusRequest | ShutdownRequest;

/** A validated request envelope. The method may still be unknown so it can receive METHOD_NOT_FOUND. */
export interface RequestEnvelope {
  version: typeof PROTOCOL;
  id: RequestId;
  method: string;
  params: unknown;
}

export interface InitializeResult {
  protocol: typeof PROTOCOL;
  implementation: { name: string; version: string };
  capabilities: {
    transport: readonly ["stdio", "socket"];
    methods: readonly ["initialize", "session/sync", "project", "status", "shutdown"];
    dshSession: true;
    agentLoop: false;
  };
}
export interface SyncResult { sessionId: string; revision: number; eventCount: number; messageCount: number }
export interface ProjectResult<Message = unknown> { sessionId: string; revision: number; total: number; from: number; messages: Message[] }
export interface SessionSummary { sessionId: string; revision: number; eventCount: number; messageCount: number }
export interface StatusResult { initialized: boolean; shuttingDown: boolean; sessionCount: number; sessions: SessionSummary[] }
export interface ShutdownResult { accepted: true }

export type MethodResult = InitializeResult | SyncResult | ProjectResult | StatusResult | ShutdownResult;
export interface Success<Result extends MethodResult = MethodResult> {
  version: typeof PROTOCOL;
  id: RequestId;
  ok: true;
  result: Result;
}
export type ProtocolErrorCode =
  | "INVALID_REQUEST" | "UNSUPPORTED_VERSION" | "SHUTTING_DOWN" | "ALREADY_INITIALIZED"
  | "NOT_INITIALIZED" | "METHOD_NOT_FOUND" | "INVALID_PARAMS" | "REVISION_CONFLICT"
  | "SESSION_NOT_FOUND" | "INTERNAL";
export interface Failure {
  version: typeof PROTOCOL;
  id: RequestId | null;
  ok: false;
  error: { code: ProtocolErrorCode; message: string; data?: unknown };
}
export type Response = Success | Failure;
