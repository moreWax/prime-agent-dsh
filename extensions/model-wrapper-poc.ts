import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModelWrapper, DSH_CONTEXT_PROVIDER, type ModelWrapper } from "../src/model-wrapper.js";
import { DshContextShadow } from "../src/dsh-context-shadow.js";

/** Owns provider publication, model mapping and session event lifecycle. */
export class ModelWrapperController {
  private wrapper: ModelWrapper | undefined;
  private sourceModels: Model<Api>[] = [];

  constructor(private readonly pi: ExtensionAPI, private readonly shadow = new DshContextShadow()) {}

  register(): void {
    this.pi.on("session_start", async (_event, ctx) => { this.publish(ctx); });
    this.pi.on("model_select", async (event, ctx) => {
      if (event.model.provider !== DSH_CONTEXT_PROVIDER && !this.sourceModels.includes(event.model)) this.publish(ctx);
    });
    this.pi.registerCommand("dsh-context-wrapper-status", {
      description: "Show DSH model-wrapper shadow projection status",
      handler: async (_args, ctx) => {
        const stats = this.shadow.stats;
        ctx.ui.notify(`DSH wrapper shadow: syncs=${stats.syncs}, skips=${stats.skips}, errors=${stats.errors}, messages=${stats.lastMessageCount ?? 0}`, "info");
      },
    });
    this.pi.registerCommand("dsh-context", {
      description: "Toggle the selected model between native and DSH-context wrapped dispatch",
      handler: async (_args, ctx) => {
        try { await this.toggle(ctx); }
        catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
      },
    });
  }

  private publish(ctx: ExtensionContext): void {
    this.sourceModels = ctx.modelRegistry.getAll().filter((model) => model.provider !== DSH_CONTEXT_PROVIDER);
    this.wrapper = createModelWrapper(
      this.sourceModels,
      async (source) => ctx.modelRegistry.getApiKeyAndHeaders(source),
      undefined,
      async (context, source) => this.shadow.prepare(context, source, this.sessionKey(ctx)),
    );
    this.pi.registerProvider(DSH_CONTEXT_PROVIDER, {
      name: "DeepSeek Harness Context",
      apiKey: "internal-source-auth",
      authHeader: false,
      api: "openai-completions",
      baseUrl: "http://127.0.0.1.invalid",
      models: this.wrapper.models,
      streamSimple: this.wrapper.streamSimple,
    });
  }

  private async toggle(ctx: ExtensionContext): Promise<void> {
    const current = ctx.model;
    if (!current) throw new Error("No model is selected");
    this.publish(ctx);
    const target = current.provider === DSH_CONTEXT_PROVIDER ? this.wrapper?.sourceFor(current.id) : this.wrappedFor(current, ctx);
    if (!target) throw new Error(`Could not map selected model ${current.provider}/${current.id}`);
    if (!await this.pi.setModel(target)) throw new Error(`Model ${target.provider}/${target.id} is unavailable`);
    ctx.ui.notify(`Selected ${target.name}`, "info");
  }

  private wrappedFor(current: Model<Api>, ctx: ExtensionContext): Model<Api> | undefined {
    const definition = this.wrapper?.models.find((candidate) => {
      const source = this.wrapper?.sourceFor(candidate.id);
      return source?.provider === current.provider && source.id === current.id;
    });
    return definition ? ctx.modelRegistry.find(DSH_CONTEXT_PROVIDER, definition.id) : undefined;
  }

  private sessionKey(ctx: ExtensionContext): string {
    return `${ctx.sessionManager.getSessionId()}:${ctx.sessionManager.getLeafId() ?? "root"}`;
  }
}

/** Standalone proof-of-concept extension; not loaded by the package entry point. */
export default function modelWrapperPoc(pi: ExtensionAPI): void {
  new ModelWrapperController(pi).register();
}
