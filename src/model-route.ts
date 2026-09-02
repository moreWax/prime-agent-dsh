import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";

const SUPPORTED = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);
const HOP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "upgrade", "proxy-authorization", "proxy-authenticate", "te", "trailer"]);
const COMPAT_KEYS = new Set(["supportsStore", "supportsDeveloperRole", "supportsReasoningEffort", "supportsUsageInStreaming", "supportsFinishReason", "maxTokensField", "requiresToolResultName", "requiresAssistantAfterToolResult", "requiresThinkingAsText", "requiresReasoningContentOnAssistantMessages", "thinkingFormat", "chatTemplateKwargs", "chatTemplateArgs", "supportsThinkingTokenBudget", "supportsStrictMode", "cacheControlFormat", "supportsLongCacheRetention", "supportsEagerToolInputStreaming"]);

export interface ResolvedPrimeAuth { apiKey?: string; headers?: Record<string, string>; }
export interface PrimeModelRoute {
  model: Model<Api>;
  auth: ResolvedPrimeAuth;
  thinkingLevel?: string;
}
export interface PreparedPrimeRoute { provider: string; model: string; patch: string; env: NodeJS.ProcessEnv; proxy: PrimeInferenceProxy; fingerprint: string; }

function filteredCompat(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => COMPAT_KEYS.has(key)));
  return Object.keys(result).length ? result : undefined;
}
function reasoningEfforts(model: Model<Api>): false | Record<string, string | null> {
  if (!model.reasoning) return false;
  const map = model.thinkingLevelMap;
  if (!map) return false;
  return Object.fromEntries(Object.entries(map).filter(([, value]) => value === null || typeof value === "string"));
}
function safeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (/authorization|api-key|token|secret|cookie/i.test(name)) continue;
    if (HOP_HEADERS.has(name.toLowerCase()) || /[\r\n]/.test(name + value)) continue;
    result[name] = value;
  }
  return result;
}

export class PrimeInferenceProxy {
  private server?: Server;
  private port?: number;
  private readonly capability = randomBytes(32).toString("base64url");
  constructor(private route: PrimeModelRoute) {
    if (!SUPPORTED.has(route.model.api)) throw new Error(`Prime model API ${route.model.api} cannot be represented by DSH llm-pi-ai`);
    const target = new URL(route.model.baseUrl);
    if (!/^https?:$/.test(target.protocol)) throw new Error("Prime model endpoint must use http or https");
  }
  update(route: PrimeModelRoute): void { this.route = route; }
  get token(): string { return this.capability; }
  get baseUrl(): string { if (!this.port) throw new Error("proxy not started"); return `http://127.0.0.1:${this.port}`; }
  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer(async (request, response) => {
      try {
        const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? request.headers["x-api-key"];
        const value = Array.isArray(supplied) ? supplied[0] : supplied;
        const a = Buffer.from(value ?? ""), b = Buffer.from(this.capability);
        if (a.length !== b.length || !timingSafeEqual(a, b)) { response.writeHead(401).end(); return; }
        const upstream = new URL(this.route.model.baseUrl);
        const suffix = request.url ?? "/";
        upstream.pathname = `${upstream.pathname.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`;
        upstream.search = new URL(suffix, "http://local").search;
        const headers = new Headers();
        for (const [name, raw] of Object.entries(request.headers)) {
          if (HOP_HEADERS.has(name.toLowerCase()) || /^(authorization|x-api-key)$/i.test(name) || raw === undefined) continue;
          headers.set(name, Array.isArray(raw) ? raw.join(", ") : raw);
        }
        for (const [name, val] of Object.entries(safeHeaders(this.route.auth.headers))) headers.set(name, val);
        if (this.route.auth.apiKey) {
          if (this.route.model.api === "anthropic-messages") headers.set("x-api-key", this.route.auth.apiKey);
          else headers.set("authorization", `Bearer ${this.route.auth.apiKey}`);
        }
        const body: Buffer[] = [];
        for await (const chunk of request) body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const upstreamResponse = await fetch(upstream, { method: request.method, headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : Buffer.concat(body), redirect: "manual" });
        const outHeaders: Record<string, string> = {};
        upstreamResponse.headers.forEach((val, name) => { if (!HOP_HEADERS.has(name.toLowerCase())) outHeaders[name] = val; });
        response.writeHead(upstreamResponse.status, outHeaders);
        if (!upstreamResponse.body) { response.end(); return; }
        for await (const chunk of upstreamResponse.body) response.write(chunk);
        response.end();
      } catch (error) { response.writeHead(502, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : "upstream failure" } })); }
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(0, "127.0.0.1", () => resolve()); });
    const address = this.server.address(); if (!address || typeof address === "string") throw new Error("failed to bind inference proxy"); this.port = address.port;
  }
  async close(): Promise<void> { const server = this.server; this.server = undefined; this.port = undefined; if (server) await new Promise<void>((resolve) => server.close(() => resolve())); }
}

export async function preparePrimeRoute(route: PrimeModelRoute, dshHome: string): Promise<PreparedPrimeRoute> {
  const proxy = new PrimeInferenceProxy(route); await proxy.start();
  const fingerprint = createHash("sha256").update(JSON.stringify({ provider: route.model.provider, id: route.model.id, api: route.model.api,
    baseUrl: route.model.baseUrl, contextWindow: route.model.contextWindow, maxTokens: route.model.maxTokens,
    input: route.model.input, compat: route.model.compat, thinkingLevel: route.thinkingLevel })).digest("hex").slice(0, 16);
  const dir = join(dshHome, "prime-bridge"); await mkdir(dir, { recursive: true, mode: 0o700 });
  const patch = join(dir, `model-${fingerprint}.patch.yml`);
  const provider = "prime-selected";
  const compat = filteredCompat(route.model.compat);
  const profile = {
    displayName: `Prime: ${route.model.name}`, apiKeyEnv: "PRIME_DSH_PROXY_TOKEN", api: route.model.api,
    baseURL: proxy.baseUrl, models: [{ id: route.model.id, name: route.model.name, contextWindow: route.model.contextWindow,
      maxTokens: route.model.maxTokens, input: route.model.input, reasoningEfforts: reasoningEfforts(route.model), ...(compat ? { compat } : {}) }],
    ...(compat ? { compat } : {}),
  };
  const text = `- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config: ${JSON.stringify({ providers: { [provider]: profile } })}\n- id: acp\n  name: '@deepseek-ai/dsh-acp'\n  inject: [acpAppStartup]\n  config: ${JSON.stringify({ provider, model: route.model.id })}\n`;
  await writeFile(patch, text, { mode: 0o600 });
  return { provider, model: route.model.id, patch, env: { PRIME_DSH_PROXY_TOKEN: proxy.token }, proxy, fingerprint };
}

export class PrimeRouteRegistry {
  private routes = new Map<string, PreparedPrimeRoute>();
  async prepare(route: PrimeModelRoute, dshHome: string): Promise<PreparedPrimeRoute> {
    const key = createHash("sha256").update(JSON.stringify({ provider: route.model.provider, id: route.model.id,
      api: route.model.api, baseUrl: route.model.baseUrl, contextWindow: route.model.contextWindow,
      maxTokens: route.model.maxTokens, input: route.model.input, compat: route.model.compat,
      thinkingLevel: route.thinkingLevel })).digest("hex");
    const existing = this.routes.get(key);
    if (existing) { existing.proxy.update(route); return existing; }
    const prepared = await preparePrimeRoute(route, dshHome);
    this.routes.set(key, prepared);
    return prepared;
  }
  async closeAll(): Promise<void> {
    const routes = [...this.routes.values()]; this.routes.clear();
    await Promise.allSettled(routes.map((route) => route.proxy.close()));
  }
}
