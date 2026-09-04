import { spawn } from "node:child_process";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { buildModels, PROVIDER_API, PROVIDER_BASE_URL, PROVIDER_ID } from "./dsh-provider-catalog.js";
import { classifyTurnEnd, textBlockKey, thinkingBlockKey, type TurnOutcome } from "./dsh-provider-turn-reasons.js";
import type { ResolvedConfig } from "./dsh-provider-types.js";
import {
  destroyAgent,
  getOrCreateAgent,
  runTurn,
  type AgentEntry,
  type SessionEventShape,
} from "./dsh-provider-host.js";

const PROVIDER_DISPLAY_NAME = "DeepSeek Harness";

// ---------------------------------------------------------------------------
// Per-conversation runtime (mirrors pi-factory-droid's InstanceRuntime).
// ---------------------------------------------------------------------------
export interface InstanceRuntime {
  cwd: string;
  /** Stable identity of the Pi CONVERSATION (session id, survives resume). */
  sessionKey: string;
  approvalAnswerer?: (request: { toolName: string; reason?: string }) => Promise<boolean>;
}

export function createInstanceRuntime(): InstanceRuntime {
  return { cwd: process.cwd(), sessionKey: process.cwd() };
}

const sessionRuntimes = new Map<string, InstanceRuntime>();
const MAX_SESSION_RUNTIMES = 256;

export function bindSessionRuntime(sessionId: string, runtime: InstanceRuntime): void {
  sessionRuntimes.delete(sessionId);
  sessionRuntimes.set(sessionId, runtime);
  while (sessionRuntimes.size > MAX_SESSION_RUNTIMES) {
    const oldest = sessionRuntimes.keys().next().value;
    if (oldest === undefined) break;
    sessionRuntimes.delete(oldest);
  }
}

function resolveCallRuntime(
  options: SimpleStreamOptions | undefined,
  fallback: InstanceRuntime,
): InstanceRuntime {
  const sessionId = (options as { sessionId?: unknown } | undefined)?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) return fallback;
  const bound = sessionRuntimes.get(sessionId);
  if (bound) return bound;
  return { ...fallback, sessionKey: sessionId };
}

export function registerProvider(
  pi: ExtensionAPI,
  cfg: ResolvedConfig,
  runtime: InstanceRuntime,
): void {
  const config: ProviderConfig = {
    name: PROVIDER_DISPLAY_NAME,
    baseUrl: PROVIDER_BASE_URL,
    // Sentinel key: pi's streamSimple providers must resolve a non-empty apiKey
    // or headers before a turn will run, but DSH manages its own auth
    // (~/.dsh/.credentials.yaml). Never used by DSH.
    apiKey: "dsh-managed",
    api: PROVIDER_API,
    models: buildModels(),
    streamSimple: (model, context, options) =>
      streamDsh(model, context, options, cfg, runtime),
  };
  pi.registerProvider(PROVIDER_ID, config);
}

// ---------------------------------------------------------------------------
// Streaming — dispatch by mode
// ---------------------------------------------------------------------------

function streamDsh(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  cfg: ResolvedConfig,
  instanceRuntime: InstanceRuntime,
): AssistantMessageEventStream {
  if (cfg.mode === "oneshot") {
    return streamDshOneShot(model, context, options, cfg, instanceRuntime);
  }
  return streamDshPool(model, context, options, cfg, instanceRuntime);
}

// ---------------------------------------------------------------------------
// Pooled streaming (Design A — in-process DSH tree)
// ---------------------------------------------------------------------------

function streamDshPool(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  cfg: ResolvedConfig,
  instanceRuntime: InstanceRuntime,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const runtime = resolveCallRuntime(options, instanceRuntime);

  void (async () => {
    const output = createEmptyOutput(model);
    let entryRef: AgentEntry | undefined;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const turn = extractLatestTurn(context);
      if (turn.text.length > MAX_PROMPT_CHARS) {
        throw new Error(
          `Prompt too long (${turn.text.length}  characters; limit  ${MAX_PROMPT_CHARS}); split it and retry.`,
        );
      }

      const entry = await getOrCreateAgent(runtime.sessionKey, {
        cwd: runtime.cwd,
        model: cfg.model,
        poolMax: cfg.poolMax,
        idleTtlMs: cfg.poolIdleTtlMs,
        fullAccess: cfg.fullAccess,
        approvalAnswerer: runtime.approvalAnswerer,
      });
      entryRef = entry;
      const translator = new TurnTranslator(output, stream);

      stream.push({ type: "start", partial: output });
      await runTurn(entry, turn.text, options?.signal, (event) => translator.onEvent(event));

      if (aborted || options?.signal?.aborted || translator.turnReason === "aborted") {
        // Abort preserves the pooled session (droid rule) — do NOT destroy.
        output.stopReason = "aborted";
        output.errorMessage = "aborted";
        stream.push({ type: "error", reason: "aborted", error: output });
        stream.end();
        return;
      }

      if (translator.turnReason === "error") {
        // A real turn failure destroys the pooled session (droid rule).
        const message = translator.turnError ?? "DSH turn failed";
        output.stopReason = "error";
        output.errorMessage = message;
        stream.push({ type: "error", reason: "error", error: output });
        stream.end();
        if (entryRef) void destroyAgent(entryRef);
        return;
      }

      // completed, or an incomplete turn (blocked / max-tokens / interrupted):
      // deliver the partial text with a diagnostic (provider semantics).
      if (translator.turnReason === "incomplete") {
        output.diagnostics = [
          {
            type: "dsh-incomplete-turn",
            timestamp: Date.now(),
            error: {
              name: "DshIncompleteTurn",
              message: translator.turnError ?? "DSH turn incomplete",
            },
          },
        ];
      }

      translator.closeOpenBlocks();
      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      const reason: "aborted" | "error" = aborted || options?.signal?.aborted ? "aborted" : "error";
      output.stopReason = reason;
      output.errorMessage = error instanceof Error ? error.message : String(error);
      if (reason === "error" && entryRef) void destroyAgent(entryRef);
      stream.push({ type: "error", reason, error: output });
      stream.end();
    } finally {
      options?.signal?.removeEventListener("abort", onAbort);
    }
  })();

  return stream;
}

// ---------------------------------------------------------------------------
// Session-event → Pi event translator
// ---------------------------------------------------------------------------

class TurnTranslator {
  private readonly indexOf = new Map<string, number>();
  private readonly openText = new Set<string>();
  private readonly openThinking = new Set<string>();
  /**
   * Tool activity as thinking blocks AT THEIR OWN chronological position —
   * one block per tool call, keyed by callId. Pi renders thinking streams in
   * order, so think → tool → think → tool interleaves by time (the operator's
   * requirement), unlike the separate tool-row lane which only stacks at the
   * bottom. Never toolCall blocks: those make Pi's agent loop take over tool
   * execution and re-drive the turn (the infinite loop).
   */
  private readonly openToolThinking = new Map<string, number>();
  turnReason: TurnOutcome = "stop";
  turnError: string | undefined;

  constructor(
    private readonly output: AssistantMessage,
    private readonly stream: AssistantMessageEventStream,
  ) {}

  onEvent(event: SessionEventShape): void {
    if (event.type === "assistant/chunk") {
      const data = event.data as { chunk?: unknown; step?: unknown } | undefined;
      this.onChunk(data?.chunk, typeof data?.step === "number" ? data.step : 0);
    } else if (event.type === "turn/end") {
      this.onTurnEnd((event.data as { reason?: unknown })?.reason);
    } else if (event.type === "tool/call") {
      this.toolCall(event.data);
    } else if (event.type === "tool/result") {
      this.toolResult(event.data);
    }
  }

  private onChunk(chunk: unknown, step: number): void {
    if (!chunk || typeof chunk !== "object") return;
    const c = chunk as Record<string, unknown>;
    switch (c.type) {
      case "text-delta":
        this.textDelta(step, c.index as number, c.text as string);
        return;
      case "reasoning-delta":
        this.reasoningDelta(step, c.index as number, c.text as string);
        return;
      case "block-end":
        this.blockEnd(step, c);
        return;
      case "usage":
        this.usage(c.usage as Record<string, unknown>);
        return;
      default:
        // NOTE: `tool-call-delta` chunks are deliberately NOT surfaced as Pi
        // toolcall_* events. DSH owns its tool loop; putting toolCall blocks
        // into the Pi message makes Pi's agent loop take over tool execution
        // (it injects empty toolResults) and re-drive the turn — an infinite
        // loop. Tool activity is shown as thinking blocks instead (droid
        // agent-mode parity: "Pi receives only assistant text/thinking").
        return;
    }
  }

  private textDelta(step: number, index: number, text: string): void {
    // DSH restarts block indices on every agent step, so the key must include
    // the step — otherwise every step's reasoning/text collapses into ONE
    // block at the top and tools pile below (the segregated look). With
    // step-aware keys the content array follows the true time order.
    const key = textBlockKey(step, index);
    let contentIndex = this.indexOf.get(key);
    if (contentIndex === undefined) {
      contentIndex = this.output.content.length;
      this.output.content.push({ type: "text", text: "" });
      this.indexOf.set(key, contentIndex);
      this.openText.add(key);
      this.stream.push({ type: "text_start", contentIndex, partial: this.output });
    }
    const block = this.output.content[contentIndex];
    if (block?.type !== "text") return;
    block.text += text;
    this.stream.push({ type: "text_delta", contentIndex, delta: text, partial: this.output });
  }

  private reasoningDelta(step: number, index: number, text: string): void {
    const key = thinkingBlockKey(step, index);
    let contentIndex = this.indexOf.get(key);
    if (contentIndex === undefined) {
      contentIndex = this.output.content.length;
      this.output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
      this.indexOf.set(key, contentIndex);
      this.openThinking.add(key);
      this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
    }
    const block = this.output.content[contentIndex];
    if (block?.type !== "thinking") return;
    block.thinking += text;
    this.stream.push({ type: "thinking_delta", contentIndex, delta: text, partial: this.output });
  }

  private blockEnd(step: number, c: Record<string, unknown>): void {
    const index = c.index as number;
    const block = c.block as { type?: string; text?: string } | undefined;
    if (!block) return;
    if (block.type === "text") {
      this.closeText(step, index, block.text ?? "");
    } else if (block.type === "reasoning") {
      this.closeThinking(step, index, block.text ?? "");
    }
    // `tool-call` block-ends are ignored: the tool log is built from the
    // `tool/call` + `tool/result` events and rendered at the bottom.
  }

  private closeText(step: number, index: number, text: string): void {
    const key = textBlockKey(step, index);
    let contentIndex = this.indexOf.get(key);
    if (contentIndex === undefined) {
      // Some agent steps emit NO text-delta chunks — the assembled text only
      // arrives with block-end. Create the block here so the content is not
      // dropped and still lands at its chronological position.
      contentIndex = this.output.content.length;
      this.output.content.push({ type: "text", text: "" });
      this.indexOf.set(key, contentIndex);
      this.stream.push({ type: "text_start", contentIndex, partial: this.output });
    }
    const block = this.output.content[contentIndex];
    if (block?.type === "text") {
      if (text) block.text = text; // block-end carries the assembled text
      this.openText.delete(key);
      this.stream.push({
        type: "text_end",
        contentIndex,
        content: block.text,
        partial: this.output,
      });
    }
  }

  private closeThinking(step: number, index: number, text: string): void {
    const key = thinkingBlockKey(step, index);
    let contentIndex = this.indexOf.get(key);
    if (contentIndex === undefined) {
      // Same as closeText: reasoning often has no delta chunks — the
      // assembled reasoning only arrives with block-end.
      contentIndex = this.output.content.length;
      this.output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
      this.indexOf.set(key, contentIndex);
      this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
    }
    const block = this.output.content[contentIndex];
    if (block?.type === "thinking") {
      if (text) block.thinking = text;
      this.openThinking.delete(key);
      this.stream.push({
        type: "thinking_end",
        contentIndex,
        content: block.thinking,
        partial: this.output,
      });
    }
  }

  // -- tool activity: thinking blocks interleaved by time ------------------

  private toolCall(data: unknown): void {
    const d = data as { callId?: unknown; name?: unknown; arguments?: unknown } | undefined;
    const callId = scalarText(d?.callId);
    const name = typeof d?.name === "string" && d.name ? d.name : "tool";
    const argsText =
      typeof d?.arguments === "string" ? summarizeArgs(d.arguments) : summarizeArgs(JSON.stringify(d?.arguments ?? {}));
    const contentIndex = this.output.content.length;
    this.output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
    this.openToolThinking.set(callId, contentIndex);
    this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
    const text = `[tool] ${name} ${argsText}`;
    const block = this.output.content[contentIndex];
    if (block?.type === "thinking") block.thinking += text;
    this.stream.push({ type: "thinking_delta", contentIndex, delta: text, partial: this.output });
  }

  private toolResult(data: unknown): void {
    const d = data as { callId?: unknown; message?: unknown } | undefined;
    const callId = scalarText(d?.callId);
    const contentIndex = this.openToolThinking.get(callId);
    const block = contentIndex === undefined ? undefined : this.output.content[contentIndex];
    if (contentIndex === undefined || block?.type !== "thinking") return;
    const text = `\n[tool result] ${extractToolResultText(d?.message)}`;
    block.thinking += text;
    this.stream.push({ type: "thinking_delta", contentIndex, delta: text, partial: this.output });
    this.openToolThinking.delete(callId);
    this.stream.push({
      type: "thinking_end",
      contentIndex,
      content: block.thinking,
      partial: this.output,
    });
  }

  private usage(usage: Record<string, unknown> | undefined): void {
    if (!usage) return;
    const out = this.output.usage;
    // DSH's `usage` chunk is PER MODEL CALL, and its agent loop re-sends the
    // whole conversation on every step — so the prompt-side counters describe
    // the SAME context N times, not N different contexts. Pi reads them as the
    // current context size (compaction thresholds, and pi-ai's silent-overflow
    // check `input + cacheRead > contextWindow`), so they must track the LAST
    // call. A 39-step turn summed to 7.0M against a real context of 193k.
    out.input = toNumber(usage.inputTokens);
    out.cacheRead = toNumber(usage.cacheReadTokens);
    out.cacheWrite = toNumber(usage.cacheWriteTokens);
    // Generated tokens are the one genuinely additive quantity.
    const stepOutput = toNumber(usage.outputTokens) + toNumber(usage.reasoningTokens);
    out.output += stepOutput;
    // Pi's convention across providers is input+output+cacheRead+cacheWrite, i.e.
    // the context AFTER the reply. Only this step's output may be added: every
    // earlier step's output is already inside this step's prompt.
    out.totalTokens = out.input + out.cacheRead + out.cacheWrite + stepOutput;
  }

  private onTurnEnd(reason: unknown): void {
    const kind = (reason as { kind?: unknown } | undefined)?.kind;
    this.turnReason = classifyTurnEnd(kind);
    if (this.turnReason === "error") {
      const message = (reason as { error?: { message?: unknown } })?.error?.message;
      this.turnError = typeof message === "string" && message ? message : "DSH turn failed";
    } else if (this.turnReason === "incomplete") {
      this.turnError = `DSH turn incomplete (${scalarText(kind, "unknown")})`;
    }
  }

  /** Close any still-open content blocks before `done`. */
  closeOpenBlocks(): void {
    for (const key of [...this.openText]) {
      const contentIndex = this.indexOf.get(key);
      const block = contentIndex === undefined ? undefined : this.output.content[contentIndex];
      if (contentIndex !== undefined && block?.type === "text") {
        this.stream.push({
          type: "text_end",
          contentIndex,
          content: block.text,
          partial: this.output,
        });
      }
    }
    this.openText.clear();
    for (const key of [...this.openThinking]) {
      const contentIndex = this.indexOf.get(key);
      const block = contentIndex === undefined ? undefined : this.output.content[contentIndex];
      if (contentIndex !== undefined && block?.type === "thinking") {
        this.stream.push({
          type: "thinking_end",
          contentIndex,
          content: block.thinking,
          partial: this.output,
        });
      }
    }
    this.openThinking.clear();
    // Close any tool thinking blocks still open (a turn that ended without a
    // tool/result event, e.g. abort mid-call).
    for (const callId of [...this.openToolThinking.keys()]) {
      const contentIndex = this.openToolThinking.get(callId);
      const block = contentIndex === undefined ? undefined : this.output.content[contentIndex];
      this.openToolThinking.delete(callId);
      if (contentIndex !== undefined && block?.type === "thinking") {
        this.stream.push({
          type: "thinking_end",
          contentIndex,
          content: block.thinking,
          partial: this.output,
        });
      }
    }
  }
}


function scalarText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return fallback;
}

function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Single-line summary of a tool's raw-JSON arguments, truncated. */
function summarizeArgs(raw: string): string {
  const singleLine = raw.replace(/\s+/g, " ").trim();
  return singleLine.length > 160 ? `${singleLine.slice(0, 160)}…` : singleLine;
}

/** Extract the text payload of a dsh tool/result message (defensive). */
function extractToolResultText(message: unknown): string {
  const m = message as
    | { content?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }>; isError?: boolean }> }
    | undefined;
  const parts: string[] = [];
  for (const item of m?.content ?? []) {
    if (item?.type !== "tool-result") continue;
    for (const inner of item.content ?? []) {
      if (inner?.type === "text" && inner.text) parts.push(inner.text);
    }
    if (item.isError) parts.push("(tool error)");
  }
  const text = parts.join("\n").trim();
  return text.length > 400 ? `${text.slice(0, 400)}…` : (text || "(no output)");
}

// ---------------------------------------------------------------------------
// One-shot streaming (path A — the config-selectable fallback)
// ---------------------------------------------------------------------------

function streamDshOneShot(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  cfg: ResolvedConfig,
  instanceRuntime: InstanceRuntime,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const runtime = resolveCallRuntime(options, instanceRuntime);

  void (async () => {
    const output = createEmptyOutput(model);
    let aborted = false;
    const onAbort = () => {
      aborted = true;
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      stream.push({ type: "start", partial: output });

      // DSH owns context: do NOT re-forward pi's AGENTS.md/skills (double-load).
      const turn = extractLatestTurn(context);

      const result = await runDshOneShot(turn.text, runtime.cwd, cfg, options?.signal);

      if (aborted || options?.signal?.aborted) {
        output.stopReason = "aborted";
        output.errorMessage = "aborted";
        stream.push({ type: "error", reason: "aborted", error: output });
        stream.end();
        return;
      }

      const text = result.stdout.replace(/\n+$/, "");

      if (result.code !== 0) {
        const message =
          result.stderr.trim() ||
          (result.code === null ? "DSH terminated by signal" : `DSH exit code ${result.code}`);
        if (!text) {
          throw new Error(message);
        }
        output.diagnostics = [
          {
            type: "dsh-incomplete-turn",
            timestamp: Date.now(),
            error: { name: "DshIncompleteTurn", message },
          },
        ];
      }

      const index = output.content.length;
      output.content.push({ type: "text", text: "" });
      stream.push({ type: "text_start", contentIndex: index, partial: output });
      output.content[index] = { type: "text", text };
      stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: output });
      stream.push({ type: "text_end", contentIndex: index, content: text, partial: output });

      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      const reason: "aborted" | "error" = aborted || options?.signal?.aborted ? "aborted" : "error";
      output.stopReason = reason;
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason, error: output });
      stream.end();
    } finally {
      options?.signal?.removeEventListener("abort", onAbort);
    }
  })();

  return stream;
}

/** Spawn `dsh --profile headless "<prompt>"` and collect stdout/stderr. */
const MAX_PROMPT_CHARS = 250_000;

function runDshOneShot(
  prompt: string,
  cwd: string,
  cfg: ResolvedConfig,
  signal: AbortSignal | undefined,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  if (prompt.length > MAX_PROMPT_CHARS) {
    return Promise.reject(
      new Error(`Prompt too long (${prompt.length}  characters; limit  ${MAX_PROMPT_CHARS}); split it and retry.`),
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.dshBin, ["--profile", "headless", prompt], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGTERM");
        const hardKill = setTimeout(() => child.kill("SIGKILL"), 6000);
        hardKill.unref?.();
        reject(new Error(`DSH timed out (${cfg.timeoutMs}ms)`));
      });
    }, cfg.timeoutMs);
    const onAbort = (): void => {
      finish(() => {
        clearTimeout(timer);
        child.kill("SIGTERM");
        const hardKill = setTimeout(() => child.kill("SIGKILL"), 6000);
        hardKill.unref?.();
        reject(new Error("aborted"));
      });
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr?.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", (err) => {
      finish(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      });
    });
    child.on("close", (code) => {
      finish(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ stdout, stderr, code });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEmptyOutput(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function extractLatestTurn(context: Context): { text: string } {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index];
    if (!message || message.role !== "user") continue;
    if (typeof message.content === "string") return { text: message.content };
    const items = message.content;
    const text = items
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    const hasImage = items.some((item) => item.type === "image");
    if (text || !hasImage) return { text };
    // The image itself cannot be forwarded to dsh (no image input); tell dsh an
    // attachment arrived instead of sending nothing.
    return { text: "请查看图片附件。" };
  }
  return { text: "" };
}
