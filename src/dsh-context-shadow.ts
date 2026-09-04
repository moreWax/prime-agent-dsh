import { createHash } from "node:crypto";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { ContextService } from "./dsh-context-service.js";
import { ContextProtocolClient, type BranchKey } from "./context-protocol.js";
import { primeToDsh, dshToPrime, type PrimeMessage } from "./context-converter.js";
import { stableJson } from "./prefix-metrics.js";

export interface ShadowProjectionStats { syncs: number; skips: number; errors: number; lastMessageCount?: number }
const primeMessage = (value: unknown): PrimeMessage => { if(typeof value!=="object"||value===null||!("role" in value)||typeof value.role!=="string") throw new TypeError("invalid Prime message"); return value as PrimeMessage; };
export class DshContextShadow {
 private readonly client:ContextProtocolClient; private readonly revisions=new Map<string,number>(); readonly stats:ShadowProjectionStats={syncs:0,skips:0,errors:0};
 constructor(service=new ContextService()){this.client=new ContextProtocolClient(request=>service.handle(request));const initialized=this.client.call("initialize");if(!initialized.ok)throw new Error(initialized.error.message);}
 async prepare(context:Context,_model:Model<Api>,key:BranchKey={sessionId:"provider-call",branchId:"root"}):Promise<Context>{const encoded=JSON.stringify([key.sessionId,key.branchId]);try{const canonical=context.messages.map((message,index)=>primeToDsh(primeMessage(message),{},`prime-${createHash("sha256").update(`${index}:`).update(stableJson(message)).digest("hex").slice(0,32)}`));const response=this.client.call("session/sync-canonical",{key,messages:canonical,expectedRevision:this.revisions.get(encoded)??0});if(!response.ok){this.stats.errors++;return Promise.resolve(context);}const projection=this.client.call("project",{key});if(!projection.ok){this.stats.errors++;return Promise.resolve(context);}const roundTrip=projection.result.messages.map(message=>dshToPrime(message));if(stableJson(roundTrip)!==stableJson(context.messages)){this.stats.skips++;return Promise.resolve(context);}this.revisions.set(encoded,response.result.revision);this.stats.syncs++;this.stats.lastMessageCount=response.result.messageCount;}catch{this.stats.skips++;}return Promise.resolve(context);}
}
