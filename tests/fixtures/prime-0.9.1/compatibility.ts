import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

// Compile against the declarations installed with Prime Agent 0.9.1. This is
// deliberately not satisfied by the npm 0.84 compatibility overload.
export function install091(pi: ExtensionAPI, api: Api, streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream): void {
  const config: ProviderConfig = { api, streamSimple };
  pi.unregisterProvider(`dsh-transparent-${encodeURIComponent(api)}`);
  pi.registerProvider(`dsh-transparent-${encodeURIComponent(api)}`, config);
}
