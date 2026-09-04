import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ProviderHeaders,
  SimpleStreamOptions,
  StreamFunction,
} from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";

export const DSH_CONTEXT_PROVIDER = "dsh-context";

export interface SourceAuth {
  ok: true;
  apiKey?: string;
  headers?: ProviderHeaders;
  baseUrl?: string;
  env?: Record<string, string>;
}

export type SourceAuthResolver = (model: Model<Api>) => Promise<SourceAuth | { ok: false; error: string }>;
export type OriginalStreamSimple = StreamFunction<Api, SimpleStreamOptions>;
export type OriginalStreamLoader = (api: Api) => Promise<OriginalStreamSimple>;
export type ContextPreparer = (context: Context, source: Model<Api>) => Promise<Context>;

type ApiModule = { streamSimple: (...args: never[]) => AssistantMessageEventStream };
const originalApiLoaders: Record<string, () => Promise<ApiModule>> = {
  "anthropic-messages": () => import("@earendil-works/pi-ai/api/anthropic-messages"),
  "azure-openai-responses": () => import("@earendil-works/pi-ai/api/azure-openai-responses"),
  "bedrock-converse-stream": () => import("@earendil-works/pi-ai/api/bedrock-converse-stream"),
  "google-generative-ai": () => import("@earendil-works/pi-ai/api/google-generative-ai"),
  "google-vertex": () => import("@earendil-works/pi-ai/api/google-vertex"),
  "mistral-conversations": () => import("@earendil-works/pi-ai/api/mistral-conversations"),
  "openai-codex-responses": () => import("@earendil-works/pi-ai/api/openai-codex-responses"),
  "openai-completions": () => import("@earendil-works/pi-ai/api/openai-completions"),
  "openai-responses": () => import("@earendil-works/pi-ai/api/openai-responses"),
  "pi-messages": () => import("@earendil-works/pi-ai/api/pi-messages"),
};

/** Load the concrete API module, never the provider registry/compat dispatcher. */
export async function loadOriginalStreamSimple(api: Api): Promise<OriginalStreamSimple> {
  const load = originalApiLoaders[api];
  if (!load) throw new Error(`DSH context wrapper does not support source API ${api}`);
  return (await load()).streamSimple as OriginalStreamSimple;
}

function wrapperId(source: Model<Api>): string {
  return Buffer.from(JSON.stringify([source.provider, source.id]), "utf8").toString("base64url");
}

export interface WrapperModelDefinition {
  id: string;
  name: string;
  api: Api;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  input: ("text" | "image")[];
  cost: Model<Api>["cost"];
  contextWindow: number;
  maxTokens: number;
  samplingParams?: Record<string, unknown>;
  compat?: Model<Api>["compat"];
}

export interface ModelWrapper {
  models: WrapperModelDefinition[];
  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
  sourceFor(wrapperModelId: string): Model<Api> | undefined;
}

/**
 * Build a custom-provider catalog plus a transparent stream handler.
 *
 * The source Model objects are retained privately. On each call source auth is
 * freshly resolved, then the concrete pi-ai API module is called with that
 * source model. The returned events are forwarded by lazyStream unchanged.
 */
export function createModelWrapper(
  sourceModels: readonly Model<Api>[],
  resolveAuth: SourceAuthResolver,
  loadStream: OriginalStreamLoader | undefined = loadOriginalStreamSimple,
  prepareContext: ContextPreparer = (context) => Promise.resolve(context),
): ModelWrapper {
  const sources = new Map<string, Model<Api>>();
  const models: WrapperModelDefinition[] = [];
  for (const source of sourceModels) {
    if (source.provider === DSH_CONTEXT_PROVIDER) continue;
    if (!originalApiLoaders[source.api] && loadStream === loadOriginalStreamSimple) continue;
    const id = wrapperId(source);
    if (sources.has(id)) continue;
    sources.set(id, source);
    models.push({
      id,
      name: `DSH Context · ${source.name} (${source.provider})`,
      api: source.api,
      // Required by registerProvider's model schema; concrete dispatch uses
      // the retained source model and its freshly resolved base URL instead.
      baseUrl: source.baseUrl,
      reasoning: source.reasoning,
      thinkingLevelMap: source.thinkingLevelMap,
      input: [...source.input],
      cost: { ...source.cost },
      contextWindow: source.contextWindow,
      maxTokens: source.maxTokens,
      samplingParams: source.samplingParams,
      compat: source.compat,
    });
  }

  return {
    models,
    sourceFor: (id) => sources.get(id),
    streamSimple(model, context, options) {
      return lazyStream(model, async () => {
        const source = sources.get(model.id);
        if (!source) throw new Error(`Unknown DSH context wrapper model ${model.id}`);
        const auth = await resolveAuth(source);
        if (!auth.ok) throw new Error(`Could not resolve ${source.provider}/${source.id} authentication: ${auth.error}`);
        const preparedContext = await prepareContext(context, source);
        const streamSimple = await (loadStream ?? loadOriginalStreamSimple)(source.api);
        const sourceModel = auth.baseUrl ? { ...source, baseUrl: auth.baseUrl } : source;
        return streamSimple(sourceModel, preparedContext, {
          ...options,
          apiKey: auth.apiKey,
          env: { ...options?.env, ...auth.env },
          headers: { ...auth.headers, ...options?.headers },
        });
      });
    },
  };
}
