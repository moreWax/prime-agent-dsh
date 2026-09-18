import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import * as PiAi from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { transcriptFromMessages, type TranscriptMessage } from "./context-seed.js";
import {
  DSH_CHECKPOINT_CUSTOM_TYPE,
  deriveBaseDshSessionId,
  deriveForkedDshSessionId,
  findLatestPrimeUserEntryId,
  findNearestDshBranchCheckpoint,
} from "./dsh-branch-checkpoint.js";
import type { Api, AssistantMessage, AssistantMessageEventStream, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ResolvedConfig } from "./dsh-provider-types.js";
import { bindSessionRuntime, createInstanceRuntime, streamDsh, type InstanceRuntime } from "./dsh-provider.js";
import { PrimeRouteRegistry } from "./model-route.js";

const INTERNAL_PROVIDERS = new Set(["dsh"]);
const REGISTRATION_PREFIX = "dsh-transparent-";
type StreamSimple = NonNullable<ProviderConfig["streamSimple"]>;

interface ApiRegistrySurface {
  getApiProvider(api: Api): { streamSimple: StreamSimple } | undefined;
}

function hasApiRegistry(value: unknown): value is ApiRegistrySurface {
  return typeof value === "object" && value !== null && "getApiProvider" in value
    && typeof value.getApiProvider === "function";
}

function registrationName(api: Api): string {
  return `${REGISTRATION_PREFIX}${encodeURIComponent(api)}`;
}

type TransparentProviderHost = Pick<ExtensionAPI, "on" | "appendEntry" | "registerCommand" | "registerProvider" | "unregisterProvider"> & Partial<Pick<ExtensionAPI, "getThinkingLevel">>;

export interface TransparentProviderControllerOptions {
  dshHome: (ctx: ExtensionContext) => string;
  /** Test seam; production reads Prime's installed pi-ai API registry. */
  getNativeStream?: (api: Api) => StreamSimple | undefined;
}

/** Prime's continual-harness refinement is a one-shot auxiliary request, not a user turn. */
export function isPrimeRefinementContext(context: { systemPrompt?: string }): boolean {
  const prompt = context.systemPrompt ?? "";
  return prompt.includes("Prime Agent's /refine continual harness subsystem")
    || prompt.includes("Prime Agent's automatic /refine review gate");
}

/**
 * Installs one model-free ProviderConfig per API. Prime 0.9.1 dispatches custom
 * providers by API, not by concrete Provider object. Model-free registrations
 * leave native provider/model ids, catalogs, request config and OAuth untouched.
 */
export class TransparentProviderController {
  private enabled = true;
  private runtime: InstanceRuntime = createInstanceRuntime();
  private readonly routes = new PrimeRouteRegistry();
  private readonly nativeStreams = new Map<Api, StreamSimple>();
  private readonly knownApis = new Set<Api>();
  private ctx?: ExtensionContext;

  constructor(private readonly pi: TransparentProviderHost, private readonly cfg: ResolvedConfig, private readonly options: TransparentProviderControllerOptions) {}

  /**
   * DSH runs transparent by default in every session. The session-scoped
   * command enables or disables it for the current session only — never
   * persisted, and re-enabled at the start of each session.
   */
  register(): void {
    this.pi.on("session_start", async (_event, ctx) => {
      await Promise.resolve();
      this.enabled = true;
      this.runtime = createInstanceRuntime();
      this.bind(ctx);
      this.captureAndPublish(ctx);
    });
    this.pi.on("session_shutdown", async () => { await this.routes.closeAll(); });
  }

  get isEnabled(): boolean { return this.enabled; }

  /**
   * Session-scoped switch, driven by the single /dsh-session command registered
   * by the host extension. Returns the new state.
   */
  setEnabled(next: boolean, ctx: ExtensionContext): boolean {
    this.enabled = next;
    this.bind(ctx);
    this.captureAndPublish(ctx);
    return this.enabled;
  }

  private bind(ctx: ExtensionContext): void {
    this.ctx = ctx;
    const primeSessionId = ctx.sessionManager.getSessionId?.() ?? ctx.cwd;
    this.runtime.cwd = ctx.cwd;
    this.runtime.sessionKey = primeSessionId;
    // Transparent dispatch already owns the exact session runtime. The legacy
    // selectable provider uses the global session binding map; consulting it
    // here would let that provider overwrite branch/recovery callbacks.
    this.runtime.useSessionBinding = false;
    this.runtime.approvalAnswerer = ctx.hasUI
      ? ({ toolName, reason }) => ctx.ui.confirm(`DSH permission: ${toolName}`, reason ?? "Allow this operation once outside the workspace sandbox?")
      : undefined;
    this.runtime.resolveBranchTarget = () => {
      const currentPrimeSessionId = ctx.sessionManager.getSessionId?.() ?? ctx.cwd;
      const branch = (ctx.sessionManager.getBranch?.() ?? []) as unknown[];
      const primeTurnEntryId = findLatestPrimeUserEntryId(branch);
      if (!primeTurnEntryId) throw new Error("Cannot resolve the persisted Prime user turn for DSH");
      // Prime /fork copies ancestor entries into a new session file. The
      // checkpoint remains the valid DSH source even though its recorded Prime
      // session id belongs to the parent file; the new session id is included
      // in the deterministic child id below.
      const checkpoint = findNearestDshBranchCheckpoint(branch);
      const baseSessionId = deriveBaseDshSessionId(currentPrimeSessionId, primeTurnEntryId);
      return {
        primeSessionId: currentPrimeSessionId,
        primeTurnEntryId,
        baseSessionId,
        ...(checkpoint ? {
          checkpoint: {
            dshSessionId: checkpoint.dshSessionId,
            dshBoundarySeq: checkpoint.dshBoundarySeq,
          },
          childSessionId: deriveForkedDshSessionId(
            currentPrimeSessionId,
            primeTurnEntryId,
            checkpoint.dshSessionId,
            checkpoint.dshBoundarySeq,
          ),
        } : {}),
      };
    };
    this.runtime.onTurnComplete = (info) => {
      try {
        if (!info.primeSessionId || !info.primeTurnEntryId) return;
        if (ctx.sessionManager.getSessionId?.() !== info.primeSessionId) return;
        if (ctx.sessionManager.getLeafId?.() !== info.primeTurnEntryId) return;
        this.pi.appendEntry(DSH_CHECKPOINT_CUSTOM_TYPE, {
          version: 1,
          primeSessionId: info.primeSessionId,
          primeTurnEntryId: info.primeTurnEntryId,
          dshSessionId: info.dshSessionId,
          dshBoundarySeq: info.dshBoundarySeq,
          outcome: info.reason,
        });
      } catch (error) {
        ctx.ui?.notify?.(
          `DSH checkpoint could not be persisted; do not continue this branch: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    };
    // Legacy recovery only: checkpoints preserve the full DSH event log.
    this.runtime.onRestored = (info) => {
      try {
        ctx.ui?.notify?.(`DSH conversation rebuilt from Prime transcript (${info.seededTurns} turns).`, "info");
      } catch {
        // notices never break the provider path
      }
    };
    this.runtime.resolveSeed = () => {
      try {
        return resolvePrimeTranscript(ctx);
      } catch {
        return [];
      }
    };
    bindSessionRuntime(this.runtime.sessionKey, this.runtime);
  }

  /** Public for deterministic host-level acceptance tests. */
  captureAndPublish(ctx: ExtensionContext): void {
    const nativeModels = ctx.modelRegistry.getAll()
      .filter((model) => !INTERNAL_PROVIDERS.has(model.provider));
    for (const model of nativeModels) this.knownApis.add(model.api);

    // A prior extension instance can still own these API slots after /reload.
    // Unregistering first makes Prime rebuild the native registry and reapply
    // other dynamic providers.
    for (const api of this.knownApis) this.pi.unregisterProvider(registrationName(api));
    if (!this.enabled) return; // session-scoped off: native providers resume
    this.nativeStreams.clear();
    for (const api of this.knownApis) {
      const injected = this.options.getNativeStream?.(api);
      const model = nativeModels.find((candidate) => candidate.api === api);
      const registry = ctx.modelRegistry as typeof ctx.modelRegistry & {
        getProvider?: (providerId: string) => { streamSimple?: StreamSimple } | undefined;
      };
      const provider = !injected && model ? registry.getProvider?.(model.provider) : undefined;
      const providerStream = provider?.streamSimple?.bind(provider);
      const native = injected
        ?? providerStream
        ?? (hasApiRegistry(PiAi) ? PiAi.getApiProvider(api)?.streamSimple : undefined);
      if (!native) throw new Error(`Cannot capture native streamSimple for API ${api}`);
      this.nativeStreams.set(api, native);
    }

    for (const api of this.knownApis) {
      const config: ProviderConfig = {
        api,
        streamSimple: (model, context, options) => this.dispatch(model, context, options),
      };
      this.pi.registerProvider(registrationName(api), config);
    }
  }

  private dispatch(model: Model<Api>, context: Parameters<StreamSimple>[1], options?: SimpleStreamOptions) {
    const native = this.nativeStreams.get(model.api);
    if (!native) throw new Error(`Native streamSimple is unavailable for API ${model.api}`);
    if (!this.enabled || INTERNAL_PROVIDERS.has(model.provider) || isPrimeRefinementContext(context)) {
      return native(model, context, options);
    }
    const ctx = this.ctx;
    if (!ctx) return native(model, context, options);
    this.runtime.resolveRoute = async () => {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(`Could not resolve Prime model authentication: ${auth.error}`);
      const headers = auth.headers ? Object.fromEntries(Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : undefined;
      return this.routes.prepare({ model, auth: { apiKey: auth.apiKey, headers }, thinkingLevel: model.reasoning ? this.pi.getThinkingLevel?.() : undefined }, this.options.dshHome(ctx));
    };
    // Never switch to Prime's separate transcript after a DSH failure. Doing
    // so would silently change context authorities mid-conversation.
    const out = createAssistantMessageEventStream();
    void this.pumpDsh(out, model, context, options);
    return out;
  }

  private async pumpDsh(
    out: AssistantMessageEventStream,
    model: Model<Api>,
    context: Parameters<StreamSimple>[1],
    options: SimpleStreamOptions | undefined,
  ): Promise<void> {
    try {
      for await (const event of streamDsh(model, context, options, this.cfg, this.runtime)) {
        if (event && typeof event === "object" && (event as { type?: unknown }).type === "error") {
          this.ctx?.ui?.notify?.(
            "DSH inference failed. The native provider was not used because it does not share DSH context; retry after checking /dsh-session doctor.",
            "error",
          );
        }
        out.push(event);
      }
      out.end();
    } catch (error) {
      const failed = dshTransportFailure(model, error);
      out.push({ type: "error", reason: "error", error: failed });
      out.end();
      this.ctx?.ui?.notify?.(failed.errorMessage ?? "DSH inference failed", "error");
    }
  }
}

function dshTransportFailure(model: Model<Api>, error: unknown): AssistantMessage {
  const message = error instanceof Error ? error.message : String(error);
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: `DSH inference failed without changing context: ${message}`,
    timestamp: Date.now(),
  };
}

/**
 * Stage 3: walk Prime's committed session tree and reduce it to surface
 * user/assistant text (DSH-internal events are anchored separately via
 * pi-dsh/turn entries; the transcript carries the canonical conversation).
 */
function resolvePrimeTranscript(ctx: ExtensionContext): TranscriptMessage[] {
  const manager = ctx.sessionManager as typeof ctx.sessionManager & {
    buildSessionContext?: () => { messages?: Array<{ role: string; content: unknown }> };
  };
  const resolved = manager.buildSessionContext?.().messages;
  if (Array.isArray(resolved)) {
    return omitCurrentUserFromSeed(transcriptFromMessages(resolved));
  }

  // Compatibility fallback for older Prime hosts. Current Prime versions use
  // buildSessionContext(), which respects compaction and branch summaries.
  const raw: Array<{ role: string; content: unknown }> = [];
  for (const entry of (manager.getBranch?.() ?? []) as Array<{
    type?: unknown;
    message?: { role?: unknown; content?: unknown };
  }>) {
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if ((role === "user" || role === "assistant") && entry.message) {
      raw.push({ role, content: entry.message.content });
    }
  }
  return omitCurrentUserFromSeed(transcriptFromMessages(raw));
}

/** The active provider call submits the current user turn after seeding. */
export function omitCurrentUserFromSeed(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  if (messages.at(-1)?.role === "user") return messages.slice(0, -1);
  return [...messages];
}
