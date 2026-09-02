import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModelWrapper, DSH_CONTEXT_PROVIDER, type ModelWrapper } from "../src/model-wrapper.js";
import { DshContextShadow } from "../src/dsh-context-shadow.js";

/**
 * Standalone proof-of-concept extension. Load this file explicitly; it is not
 * part of the package's main extension entry point.
 */
export default function modelWrapperPoc(pi: ExtensionAPI) {
  let wrapper: ModelWrapper | undefined;
  let sourceModels: Model<Api>[] = [];
  const dshShadow = new DshContextShadow();

  function publish(ctx: ExtensionContext): void {
    sourceModels = ctx.modelRegistry.getAll().filter((model) => model.provider !== DSH_CONTEXT_PROVIDER);
    wrapper = createModelWrapper(sourceModels, async (source) => ctx.modelRegistry.getApiKeyAndHeaders(source), undefined,
      async (context, source) => dshShadow.prepare(context, source, `${ctx.sessionManager.getSessionId()}:${ctx.sessionManager.getLeafId() ?? "root"}`));
    pi.registerProvider(DSH_CONTEXT_PROVIDER, {
      name: "DeepSeek Harness Context",
      // The wrapper provider itself never sends this credential. It resolves
      // the selected source provider's current credential inside streamSimple.
      apiKey: "internal-source-auth",
      authHeader: false,
      api: "openai-completions",
      baseUrl: "http://127.0.0.1.invalid",
      models: wrapper.models,
      streamSimple: wrapper.streamSimple,
    });
  }

  async function toggle(ctx: ExtensionContext): Promise<void> {
    const current = ctx.model;
    if (!current) throw new Error("No model is selected");
    publish(ctx);
    let target: Model<Api> | undefined;
    if (current.provider === DSH_CONTEXT_PROVIDER) {
      target = wrapper?.sourceFor(current.id);
    } else {
      const definition = wrapper?.models.find((candidate) => {
        const source = wrapper?.sourceFor(candidate.id);
        return source !== undefined && source.provider === current.provider && source.id === current.id;
      });
      target = definition && ctx.modelRegistry.find(DSH_CONTEXT_PROVIDER, definition.id);
    }
    if (!target) throw new Error(`Could not map selected model ${current.provider}/${current.id}`);
    if (!await pi.setModel(target)) throw new Error(`Model ${target.provider}/${target.id} is unavailable`);
    ctx.ui.notify(`Selected ${target.name}`, "info");
  }

  pi.on("session_start", async (_event, ctx) => { publish(ctx); });
  pi.on("model_select", async (event, ctx) => {
    // A newly discovered native model should immediately gain a wrapper entry.
    // Never republish in response to selecting our own provider: that is the
    // recursion guard for registration and selection.
    if (event.model.provider !== DSH_CONTEXT_PROVIDER && !sourceModels.includes(event.model)) publish(ctx);
  });
  pi.registerCommand("dsh-context-wrapper-status", {
    description: "Show DSH model-wrapper shadow projection status",
    handler: async (_args, ctx) => ctx.ui.notify(`DSH wrapper shadow: syncs=${dshShadow.stats.syncs}, skips=${dshShadow.stats.skips}, errors=${dshShadow.stats.errors}, messages=${dshShadow.stats.lastMessageCount ?? 0}`, "info"),
  });
  pi.registerCommand("dsh-context", {
    description: "Toggle the selected model between native and DSH-context wrapped dispatch",
    handler: async (_args, ctx) => {
      try { await toggle(ctx); }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
}
