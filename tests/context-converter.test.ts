import assert from "node:assert/strict";
import test from "node:test";
import { ConversionCapabilityError, dshToPrime, primeToDsh } from "../src/context-converter.js";

const caps: any = { admitImage: (x: any) => ({ attachmentId: "att-1", mediaType: x.mimeType, bytes: 3, width: 1, height: 1, name: x.name }), resolveImage: (x: any) => ({ data: "YWJj", mimeType: x.mediaType }) };
const samples: any[] = [
 { id:"u1", parentId:null, timestamp:"t", message:{ role:"user", content:[{type:"text",text:"hi"},{type:"image",data:"YWJj",mimeType:"image/png",name:"x"}], timestamp:1 }},
 { id:"a1", parentId:"u1", message:{ role:"assistant", content:[{type:"thinking",thinking:"hmm"},{type:"text",text:"ok"},{type:"toolCall",id:"c1",name:"bash",arguments:{command:"pwd"}}], api:"openai", provider:"p", model:"m", usage:{input:1}, stopReason:"toolUse", timestamp:2 }},
 { id:"r1", message:{ role:"toolResult", toolCallId:"c1", toolName:"bash", content:[{type:"text",text:"/tmp"},{type:"image",data:"YWJj",mimeType:"image/png"}], details:{x:1}, isError:true, timestamp:3 }},
 { id:"b1", message:{ role:"bashExecution", command:"false", output:"bad", exitCode:1, cancelled:false, truncated:false, timestamp:4 }},
 { id:"c1", message:{ role:"custom", customType:"x", content:[{type:"text",text:"ctx"}], display:false, details:{a:1}, timestamp:5 }},
 { id:"s1", message:{ role:"branchSummary", summary:"sum", fromId:"old", timestamp:6 }},
 { id:"s2", message:{ role:"compactionSummary", summary:"compact", tokensBefore:99, timestamp:7 }},
];
for (const sample of samples) test(`differential round trip ${sample.message.role}`, () => assert.deepEqual(dshToPrime(primeToDsh(sample, caps), caps), sample));
test("maps canonical DSH names and raw JSON", () => { const d:any=primeToDsh({role:"assistant",content:[{type:"toolCall",id:"x",name:"n",arguments:{a:1}}],provider:"p",model:"m"}); assert.deepEqual(d.content[0],{type:"tool-call",id:"x",name:"n",arguments:'{"a":1}'}); });
test("image conversion fails explicitly without capabilities", () => { assert.throws(() => primeToDsh(samples[0]), (e:any) => e instanceof ConversionCapabilityError && e.capability === "prime-image-admission"); const d=primeToDsh(samples[0],caps); assert.throws(() => dshToPrime(d), (e:any) => e.code === "CAPABILITY_UNAVAILABLE" && e.capability === "dsh-image-resolution"); });
