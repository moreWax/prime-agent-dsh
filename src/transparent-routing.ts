import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ResolvedConfig } from "./dsh-provider-types.js";
import { bindSessionRuntime, createInstanceRuntime, streamDsh } from "./dsh-provider.js";
import type { PrimeRouteRegistry } from "./model-route.js";

/** Providers owned by this package. They must never be wrapped. */
const INTERNAL_PROVIDERS = new Set(["dsh", "dsh-context"]);

export type DshDispatch = Provider<Api>["streamSimple"];

export interface TransparentRoutingOptions {
  config: ResolvedConfig;
  routes: PrimeRouteRegistry;
  dshHome(ctx: ExtensionContext): string;
}

/**
 * Replaces each concrete Provider in-place, retaining its identity, catalog,
 * auth implementation, refresh policy, and deferred-response operations.
 * Only stream dispatch changes. Consequently /model and session model_change
 * entries remain ordinary Prime provider/model pairs.
 */
export class TransparentDshRouter {
  private readonly originals = new Map<string, Provider<Api>>();
  private currentRuntime = createInstanceRuntime();

  constructor(private readonly pi: ExtensionAPI, private readonly options: TransparentRoutingOptions) {}

  register(): void {
    this.pi.on("session_start", async (_event, ctx) => {
      await Promise.resolve();
      this.bindSession(ctx);
      this.install(ctx);
    });
    // A dynamic provider may publish after session_start. Wrap it as soon as
    // one of its models becomes active, without changing that selection.
    this.pi.on("model_select", async (_event, ctx) => {
      await Promise.resolve();
      this.install(ctx);
    });
  }

  private bindSession(ctx: ExtensionContext): void {
    const runtime = createInstanceRuntime();
    runtime.cwd = ctx.cwd;
    runtime.sessionKey = ctx.sessionManager.getSessionId?.() ?? ctx.cwd;
    runtime.approvalAnswerer = ctx.hasUI
      ? ({ toolName, reason }) => ctx.ui.confirm(
          `DSH permission: ${toolName}`,
          reason ?? "Allow this operation once outside the workspace sandbox?",
        )
      : undefined;
    runtime.resolveRoute = (model, request) => this.prepareRoute(ctx, model, request);
    this.currentRuntime = runtime;
    bindSessionRuntime(runtime.sessionKey, runtime);
  }

  private async prepareRoute(
    ctx: ExtensionContext,
    model: Model<Api>,
    request: SimpleStreamOptions | undefined,
  ) {
    if (INTERNAL_PROVIDERS.has(model.provider)) throw new Error(`Refusing recursive DSH route for ${model.provider}/${model.id}`);
    // The Models runtime has already resolved provider auth before invoking the
    // wrapped Provider. Reuse those exact request credentials and endpoint.
    const headers = request?.headers
      ? Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : undefined;
    return this.options.routes.prepare({
      model,
      auth: { apiKey: request?.apiKey, headers },
      thinkingLevel: ctx.thinkingLevel,
    }, this.options.dshHome(ctx));
  }

  private install(ctx: ExtensionContext): void {
    for (const model of ctx.modelRegistry.getAll()) {
      if (INTERNAL_PROVIDERS.has(model.provider) || this.originals.has(model.provider)) continue;
      const original = ctx.modelRegistry.getProvider(model.provider);
      if (!original) continue;
      this.originals.set(original.id, original);
      this.pi.registerProvider(this.wrap(original));
    }
  }

  private wrap(original: Provider<Api>): Provider<Api> {
    return wrapNativeProvider(original, (model, context, request) =>
      streamDsh(model, context, request, this.options.config, this.currentRuntime));
  }
}

/** Strongly typed provider decorator, exported for deterministic tests. */
export function wrapNativeProvider(original: Provider<Api>, routed: DshDispatch): Provider<Api> {
  return {
    id: original.id,
    name: original.name,
    baseUrl: original.baseUrl,
    headers: original.headers,
    auth: original.auth,
    getModels: () => original.getModels(),
    ...(original.refreshModels ? { refreshModels: (ctx) => original.refreshModels!(ctx) } : {}),
    ...(original.filterModels ? { filterModels: (models, credential) => original.filterModels!(models, credential) } : {}),
    // Prime's agent path uses stream(); streamSimple is kept consistent for
    // extensions and completion helpers. DSH emits the common event shape.
    stream: (model, context, request) => routed(model, context, request as SimpleStreamOptions),
    streamSimple: routed,
    // Deferred operations are not new turns. Preserve their concrete provider
    // implementation so existing handles remain valid.
    ...(original.fetchDeferred ? { fetchDeferred: (model, handle, request) => original.fetchDeferred!(model, handle, request) } : {}),
    ...(original.cancelDeferred ? { cancelDeferred: (model, handle, request) => original.cancelDeferred!(model, handle, request) } : {}),
  };
}
