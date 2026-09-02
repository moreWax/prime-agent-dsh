import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export type AcpContentBlock = acp.ContentBlock;
export type AcpSessionUpdate = acp.SessionNotification;
export type AcpPermissionRequest = acp.RequestPermissionRequest;
export type AcpPermissionResponse = acp.RequestPermissionResponse;

export interface DshAcpClientOptions {
  cwd: string;
  dshHome?: string;
  dshBin?: string;
  patches?: string[];
  env?: NodeJS.ProcessEnv;
  stderrLimitBytes?: number;
  initializeTimeoutMs?: number;
  permission?: (request: AcpPermissionRequest) => Promise<AcpPermissionResponse> | AcpPermissionResponse;
  onUpdate?: (notification: AcpSessionUpdate) => void | Promise<void>;
}

export interface DshPromptResult {
  sessionId: string;
  stopReason: acp.StopReason;
  text: string;
  updates: AcpSessionUpdate[];
}

/** A subprocess-owning, standard ACP v1 client for `dsh --profile acp`. */
export class DshAcpClient {
  private readonly options: DshAcpClientOptions;
  private child?: ChildProcessWithoutNullStreams;
  private connection?: acp.ClientConnection;
  private initialized?: acp.InitializeResponse;
  private stderr = Buffer.alloc(0);
  private closing?: Promise<void>;
  private readonly text = new Map<string, string>();
  private readonly updates = new Map<string, AcpSessionUpdate[]>();
  private permissionHandler?: DshAcpClientOptions["permission"];
  private updateHandler?: DshAcpClientOptions["onUpdate"];

  constructor(options: DshAcpClientOptions) {
    if (!options.cwd) throw new Error("cwd is required");
    this.options = options;
    this.permissionHandler = options.permission;
    this.updateHandler = options.onUpdate;
  }

  setHandlers(handlers: Pick<DshAcpClientOptions, "permission" | "onUpdate">): void {
    this.permissionHandler = handlers.permission;
    this.updateHandler = handlers.onUpdate;
  }

  get capabilities(): acp.InitializeResponse | undefined { return this.initialized; }
  get boundedStderr(): string { return this.stderr.toString("utf8"); }

  async start(): Promise<acp.InitializeResponse> {
    if (this.initialized) return this.initialized;
    if (this.child) throw new Error("ACP client startup is already in progress");
    const args = ["--profile", "acp", ...this.options.patches?.flatMap((p) => ["--patch", p]) ?? []];
    const child = spawn(this.options.dshBin ?? "dsh", args, {
      cwd: this.options.cwd, env: { ...process.env, ...this.options.env,
        ...(this.options.dshHome ? { DSH_HOME: this.options.dshHome } : {}) }, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.on("data", (chunk: Buffer) => this.captureStderr(chunk));
    const earlyExit = new Promise<never>((_, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => reject(new Error(`dsh ACP exited during startup (${signal ?? code}); stderr: ${this.boundedStderr}`)));
    });
    const app = acp.client({ name: "prime-agent-dsh" })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) =>
        this.permissionHandler ? this.permissionHandler(params) : { outcome: { outcome: "cancelled" } })
      .onNotification(acp.methods.client.session.update, async ({ params }) => {
        const list = this.updates.get(params.sessionId) ?? [];
        list.push(params); this.updates.set(params.sessionId, list);
        if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text")
          this.text.set(params.sessionId, (this.text.get(params.sessionId) ?? "") + params.update.content.text);
        try { await this.updateHandler?.(params); } catch { /* presentation callbacks cannot break ACP */ }
      });
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    this.connection = app.connect(stream);
    const timeout = AbortSignal.timeout(this.options.initializeTimeoutMs ?? 15_000);
    try {
      this.initialized = await Promise.race([this.connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}
      }, { cancellationSignal: timeout }), earlyExit]);
      if (this.initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error(`Unsupported ACP protocol version ${this.initialized.protocolVersion}; expected ${acp.PROTOCOL_VERSION}`);
      }
      return this.initialized;
    } catch (error) { await this.close().catch(() => undefined); throw error; }
  }

  async newSession(): Promise<string> {
    const cx = await this.context();
    const out = await cx.request(acp.methods.agent.session.new, { cwd: this.options.cwd, mcpServers: [] });
    return out.sessionId;
  }

  async resumeSession(sessionId: string): Promise<void> {
    const cx = await this.context();
    if (!this.initialized?.agentCapabilities?.sessionCapabilities?.resume)
      throw new Error("DSH ACP server did not advertise session/resume");
    await cx.request(acp.methods.agent.session.resume, { sessionId, cwd: this.options.cwd, mcpServers: [] });
  }

  async prompt(sessionId: string, prompt: string | AcpContentBlock[], signal?: AbortSignal): Promise<DshPromptResult> {
    if (signal?.aborted) throw abortError();
    const cx = await this.context();
    this.text.set(sessionId, ""); this.updates.set(sessionId, []);
    const blocks: AcpContentBlock[] = typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt;
    const onAbort = () => { void cx.notify(acp.methods.agent.session.cancel, { sessionId }); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await cx.request(acp.methods.agent.session.prompt, { sessionId, prompt: blocks }, signal ? { cancellationSignal: signal } : undefined);
      if (signal?.aborted || response.stopReason === "cancelled") throw abortError();
      return { sessionId, stopReason: response.stopReason, text: this.text.get(sessionId) ?? "", updates: this.updates.get(sessionId) ?? [] };
    } finally { signal?.removeEventListener("abort", onAbort); }
  }

  async closeSession(sessionId: string): Promise<void> {
    const cx = await this.context();
    if (this.initialized?.agentCapabilities?.sessionCapabilities?.close) await cx.request(acp.methods.agent.session.close, { sessionId });
    else await cx.notify(acp.methods.agent.session.cancel, { sessionId });
    this.text.delete(sessionId); this.updates.delete(sessionId);
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      const conn = this.connection; const child = this.child;
      this.connection = undefined; this.child = undefined; this.initialized = undefined;
      conn?.close();
      if (child && child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        if (!await waitForExit(child, 1_000)) {
          child.kill("SIGTERM");
          if (!await waitForExit(child, 3_000)) {
            child.kill("SIGKILL");
            await waitForExit(child, 3_000);
          }
        }
      }
    })().finally(() => { this.closing = undefined; });
    return this.closing;
  }

  private async context(): Promise<acp.ClientContext> { await this.start(); return this.connection!.agent; }
  private captureStderr(chunk: Buffer): void {
    const limit = this.options.stderrLimitBytes ?? 64 * 1024;
    this.stderr = Buffer.concat([this.stderr, chunk]);
    if (this.stderr.length > limit) this.stderr = this.stderr.subarray(this.stderr.length - limit);
  }
}

function abortError(): Error { const error = new Error("DSH ACP prompt cancelled"); error.name = "AbortError"; return error; }

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.removeListener("exit", onExit); resolve(false); }, timeoutMs);
    const onExit = () => { clearTimeout(timer); resolve(true); };
    child.once("exit", onExit);
  });
}
