import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import * as PiAi from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessageEvent, AssistantMessageEventStream, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
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

type TransparentProviderHost = Pick<ExtensionAPI, "on" | "registerCommand" | "registerProvider" | "unregisterProvider">;

export interface TransparentProviderControllerOptions {
  dshHome: (ctx: ExtensionContext) => string;
  /** Test seam; production reads Prime's installed pi-ai API registry. */
  getNativeStream?: (api: Api) => StreamSimple | undefined;
}

/**
 * Installs one model-free ProviderConfig per API. Prime 0.9.1 dispatches custom
 * providers by API, not by concrete Provider object. Model-free registrations
 * leave native provider/model ids, catalogs, request config and OAuth untouched.
 */
export class TransparentProviderController {
  private enabled = true;
  private readonly runtime: InstanceRuntime = createInstanceRuntime();
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
      this.bind(ctx);
      this.captureAndPublish(ctx);
    });
    this.pi.registerCommand("dsh-session", {
      description: "Enable or disable DSH for this session (on|off|status)",
      handler: async (args, ctx) => {
        await Promise.resolve();
        const value = args.trim().toLowerCase();
        if (value === "on") this.enabled = true;
        else if (value === "off") this.enabled = false;
        else if (value !== "status") { ctx.ui.notify("Usage: /dsh-session on|off|status", "warning"); return; }
        this.bind(ctx);
        this.captureAndPublish(ctx);
        ctx.ui.notify(`DSH is ${this.enabled ? "enabled" : "disabled"} for this session.`, "info");
      },
    });
    this.pi.on("session_shutdown", async () => { await this.routes.closeAll(); });
  }

  get isEnabled(): boolean { return this.enabled; }

  private bind(ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.runtime.cwd = ctx.cwd;
    this.runtime.sessionKey = ctx.sessionManager.getSessionId?.() ?? ctx.cwd;
    this.runtime.approvalAnswerer = ctx.hasUI
      ? ({ toolName, reason }) => ctx.ui.confirm(`DSH permission: ${toolName}`, reason ?? "Allow this operation once outside the workspace sandbox?")
      : undefined;
    bindSessionRuntime(this.runtime.sessionKey, this.runtime);
  }

  /** Public for deterministic host-level acceptance tests. */
  captureAndPublish(ctx: ExtensionContext): void {
    for (const model of ctx.modelRegistry.getAll()) {
      if (!INTERNAL_PROVIDERS.has(model.provider)) this.knownApis.add(model.api);
    }

    // A prior extension instance can still own these API slots after /reload.
    // Unregistering first makes Prime rebuild the native registry and reapply
    // other dynamic providers.
    for (const api of this.knownApis) this.pi.unregisterProvider(registrationName(api));
    if (!this.enabled) return; // session-scoped off: native providers resume
    this.nativeStreams.clear();
    for (const api of this.knownApis) {
      const native = this.options.getNativeStream?.(api)
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
    if (!this.enabled || INTERNAL_PROVIDERS.has(model.provider)) return native(model, context, options);
    const ctx = this.ctx;
    if (!ctx) return native(model, context, options);
    this.runtime.resolveRoute = async () => {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(`Could not resolve Prime model authentication: ${auth.error}`);
      const headers = auth.headers ? Object.fromEntries(Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : undefined;
      return this.routes.prepare({ model, auth: { apiKey: auth.apiKey, headers }, thinkingLevel: model.reasoning ? ctx.thinkingLevel : undefined }, this.options.dshHome(ctx));
    };
    // DSH must never hold the session hostage: if its stream fails before
    // producing any content, fall back to the native provider for this turn
    // and disable DSH for the session with a visible notice.
    const out = createAssistantMessageEventStream();
    void this.pumpDshWithFallback(out, model, context, options, native);
    return out;
  }

  private async pumpDshWithFallback(
    out: AssistantMessageEventStream,
    model: Model<Api>,
    context: Parameters<StreamSimple>[1],
    options: SimpleStreamOptions | undefined,
    native: StreamSimple,
  ): Promise<void> {
    const dshStream = streamDsh(model, context, options, this.cfg, this.runtime);
    let produced = false;
    const fallback = async (): Promise<void> => {
      this.enabled = false;
      this.ctx?.ui?.notify?.(
        "DSH inference failed this turn; fell back to the native provider and disabled DSH for this session (re-enable with /dsh-session on).",
        "error",
      );
      try {
        for await (const nativeEvent of native(model, context, options)) out.push(nativeEvent as AssistantMessageEvent);
      } finally {
        out.end();
      }
    };
    try {
      for await (const event of dshStream) {
        if (!produced && event && typeof event === "object" && (event as { type?: unknown }).type === "error") {
          await fallback();
          return;
        }
        produced = true;
        out.push(event as AssistantMessageEvent);
      }
      out.end();
    } catch (error) {
      if (!produced) await fallback();
      else out.end();
    }
  }
}

interface StreamLike { [Symbol.asyncIterator](): AsyncIterator<unknown>; }

/**
 * Yields the DSH stream normally. If the stream errors or throws BEFORE any
 * content event is produced, it switches to the fallback (native) stream and
 * reports once. Content-first failures pass through untouched.
 */
export async function* fallbackOnDshFailure(
  dshStream: StreamLike,
  fallback: () => StreamLike,
): AsyncGenerator<unknown, void, void> {
  let produced = false;
  try {
    for await (const event of dshStream) {
      if (!produced) {
        if (event && typeof event === "object" && (event as { type?: unknown }).type === "error") {
          for await (const nativeEvent of fallback()) yield nativeEvent;
          return;
        }
        produced = true;
      }
      yield event;
    }
  } catch (error) {
    if (!produced) {
      for await (const nativeEvent of fallback()) yield nativeEvent;
    } else {
      throw error;
    }
  }
}
