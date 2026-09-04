import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ResolvedConfig } from "./dsh-provider-types.js";
import { bindSessionRuntime, createInstanceRuntime, streamDsh, type InstanceRuntime } from "./dsh-provider.js";
import { PrimeRouteRegistry } from "./model-route.js";

/** Provider ids owned by this package. They must never be wrapped. */
const INTERNAL_PROVIDERS = new Set(["dsh"]);

export interface TransparentProviderControllerOptions {
  initialEnabled?: boolean;
  dshHome: (ctx: ExtensionContext) => string;
}

/**
 * Re-registers each native provider under its original id, catalog and auth.
 * Only streamSimple changes. The wrapper calls DSH directly and routes DSH's
 * model calls through a capability proxy to the captured native provider.
 */
export class TransparentProviderController {
  private enabled: boolean;
  private readonly originals = new Map<string, Provider<Api>>();
  private readonly runtime: InstanceRuntime = createInstanceRuntime();
  private readonly routes = new PrimeRouteRegistry();
  private ctx?: ExtensionContext;

  constructor(private readonly pi: ExtensionAPI, private readonly cfg: ResolvedConfig, private readonly options: TransparentProviderControllerOptions) {
    this.enabled = options.initialEnabled ?? cfg.transparent;
  }

  register(): void {
    this.pi.on("session_start", async (_event, ctx) => {
      await Promise.resolve();
      this.ctx = ctx;
      this.runtime.cwd = ctx.cwd;
      this.runtime.sessionKey = ctx.sessionManager.getSessionId?.() ?? ctx.cwd;
      this.runtime.approvalAnswerer = ctx.hasUI
        ? ({ toolName, reason }) => ctx.ui.confirm(`DSH permission: ${toolName}`, reason ?? "Allow this operation once outside the workspace sandbox?")
        : undefined;
      bindSessionRuntime(this.runtime.sessionKey, this.runtime);
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
        this.captureAndPublish(ctx);
        ctx.ui.notify(`Transparent DSH wrapping is ${this.enabled ? "on" : "off"}.`, "info");
      },
    });
    this.pi.on("session_shutdown", async () => { await this.routes.closeAll(); });
  }

  get isEnabled(): boolean { return this.enabled; }

  /** Public for deterministic host-level acceptance tests. */
  captureAndPublish(ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.runtime.cwd = ctx.cwd;
    this.runtime.sessionKey = ctx.sessionManager.getSessionId?.() ?? ctx.cwd;
    bindSessionRuntime(this.runtime.sessionKey, this.runtime);
    for (const model of ctx.modelRegistry.getAll()) {
      if (INTERNAL_PROVIDERS.has(model.provider) || this.originals.has(model.provider)) continue;
      const provider = ctx.modelRegistry.getProvider(model.provider);
      if (provider) this.originals.set(model.provider, provider);
    }
    for (const provider of this.originals.values()) this.pi.registerProvider(this.wrap(provider));
  }

  private wrap(provider: Provider<Api>): Provider<Api> {
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      headers: provider.headers,
      auth: provider.auth,
      getModels: () => provider.getModels(),
      ...(provider.refreshModels ? { refreshModels: (context) => provider.refreshModels!(context) } : {}),
      ...(provider.filterModels ? { filterModels: (models, credential) => provider.filterModels!(models, credential) } : {}),
      // Prime's agent loop calls stream(), while helpers may call streamSimple().
      // Both must enter DSH or transparent mode silently bypasses the harness.
      stream: (model, context, options) => this.dispatch(provider, model, context, options as SimpleStreamOptions),
      streamSimple: (model, context, options) => this.dispatch(provider, model, context, options),
      ...(provider.fetchDeferred ? { fetchDeferred: (model, handle, options) => provider.fetchDeferred!(model, handle, options) } : {}),
      ...(provider.cancelDeferred ? { cancelDeferred: (model, handle, options) => provider.cancelDeferred!(model, handle, options) } : {}),
    } satisfies Provider<Api>;
  }

  private dispatch(provider: Provider<Api>, model: Model<Api>, context: Parameters<Provider<Api>["streamSimple"]>[1], options?: SimpleStreamOptions) {
    // Opt-out is a true native path. Calling the captured object avoids recursion
    // after its id is re-registered in Prime's model registry.
    if (!this.enabled) return provider.streamSimple(model, context, options);
    const ctx = this.ctx;
    if (!ctx) return provider.streamSimple(model, context, options);
    this.runtime.resolveRoute = async () => {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(`Could not resolve Prime model authentication: ${auth.error}`);
      const headers = auth.headers ? Object.fromEntries(Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : undefined;
      return this.routes.prepare({ model, auth: { apiKey: auth.apiKey, headers }, thinkingLevel: model.reasoning ? ctx.thinkingLevel : undefined }, this.options.dshHome(ctx));
    };
    return streamDsh(model, context, options, this.cfg, this.runtime);
  }
}
