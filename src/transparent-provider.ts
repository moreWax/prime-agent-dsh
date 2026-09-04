import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import * as PiAi from "@earendil-works/pi-ai";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
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
  initialEnabled?: boolean;
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
  private enabled: boolean;
  private readonly runtime: InstanceRuntime = createInstanceRuntime();
  private readonly routes = new PrimeRouteRegistry();
  private readonly nativeStreams = new Map<Api, StreamSimple>();
  private readonly knownApis = new Set<Api>();
  private ctx?: ExtensionContext;

  constructor(private readonly pi: TransparentProviderHost, private readonly cfg: ResolvedConfig, private readonly options: TransparentProviderControllerOptions) {
    this.enabled = options.initialEnabled ?? cfg.transparent;
  }

  register(): void {
    this.pi.on("session_start", async (_event, ctx) => {
      await Promise.resolve();
      this.bind(ctx);
      this.captureAndPublish(ctx);
    });
    this.pi.registerCommand("dsh-transparent", {
      description: "Enable or disable transparent DSH provider wrapping (on|off|status)",
      handler: async (args, ctx) => {
        await Promise.resolve();
        const value = args.trim().toLowerCase();
        if (value === "on") this.enabled = true;
        else if (value === "off") this.enabled = false;
        else if (value && value !== "status") { ctx.ui.notify("Usage: /dsh-transparent on|off|status", "warning"); return; }
        this.bind(ctx);
        this.captureAndPublish(ctx);
        ctx.ui.notify(`Transparent DSH wrapping is ${this.enabled ? "on" : "off"}.`, "info");
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
    // other dynamic providers. When wrapping is disabled (the modular default)
    // the controller stops here: nothing is captured, wrapped, or thrown at —
    // inert for every other provider, tool, and package.
    for (const api of this.knownApis) this.pi.unregisterProvider(registrationName(api));
    if (!this.enabled) return;
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
    return streamDsh(model, context, options, this.cfg, this.runtime);
  }
}
