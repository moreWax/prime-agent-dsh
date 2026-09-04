import type { Message } from "@deepseek-ai/dsh-llm";

export const PROTOCOL = "dsh-context/1" as const;
export type RequestId = string | number;
export interface BranchKey { sessionId: string; branchId: string }
export type SimpleMessage =
  | { role: "user"; content: string; source?: string }
  | { role: "assistant"; content: string; provider?: string; model?: string };
export interface SyncParams { key: BranchKey; messages: SimpleMessage[]; expectedRevision?: number }
export interface CanonicalSyncParams { key: BranchKey; messages: Message[]; expectedRevision?: number }
export interface ProjectParams { key: BranchKey; from?: number; limit?: number }
export type Method = "initialize" | "session/sync" | "session/sync-canonical" | "project" | "status" | "shutdown";
export interface Request<M extends string = string, P = unknown> { version: typeof PROTOCOL; id: RequestId; method: M; params?: P }
export interface InitializeResult { protocol: typeof PROTOCOL; implementation: { name: string; version: string }; capabilities: { transport: readonly ["in-process"]; methods: readonly Method[]; dshSession: true; agentLoop: false } }
export interface SyncResult { key: BranchKey; revision: number; eventCount: number; messageCount: number; mode: "append" | "noop" | "rebuild"; commonPrefixMessages: number }
export interface ProjectResult { key: BranchKey; revision: number; total: number; from: number; messages: Message[] }
export interface SessionSummary { key: BranchKey; revision: number; eventCount: number; messageCount: number }
export interface StatusResult { initialized: boolean; shuttingDown: boolean; sessionCount: number; sessions: SessionSummary[] }
export interface ShutdownResult { accepted: true }
export interface ResultMap { initialize: InitializeResult; "session/sync": SyncResult; "session/sync-canonical": SyncResult; project: ProjectResult; status: StatusResult; shutdown: ShutdownResult }
export type MethodResult = ResultMap[keyof ResultMap];
export interface Success<R extends MethodResult = MethodResult> { version: typeof PROTOCOL; id: RequestId; ok: true; result: R }
export type ProtocolErrorCode = "INVALID_REQUEST" | "UNSUPPORTED_VERSION" | "SHUTTING_DOWN" | "ALREADY_INITIALIZED" | "NOT_INITIALIZED" | "METHOD_NOT_FOUND" | "INVALID_PARAMS" | "REVISION_CONFLICT" | "SESSION_NOT_FOUND" | "INTERNAL";
export interface Failure { version: typeof PROTOCOL; id: RequestId | null; ok: false; error: { code: ProtocolErrorCode; message: string; data?: unknown } }
export type Response<R extends MethodResult = MethodResult> = Success<R> | Failure;

/** Typed in-process client; method/result relationships cannot be lost at call sites. */
export class ContextProtocolClient {
  private nextId = 0;
  constructor(private readonly transport: (request: Request) => Response) {}
  call<M extends keyof ResultMap>(method: M, params?: RequestParams<M>): Response<ResultMap[M]> {
    const response = this.transport({ version: PROTOCOL, id: ++this.nextId, method, params });
    return response as Response<ResultMap[M]>;
  }
}
export type RequestParams<M extends keyof ResultMap> =
  M extends "session/sync" ? SyncParams : M extends "session/sync-canonical" ? CanonicalSyncParams : M extends "project" ? ProjectParams : undefined;
