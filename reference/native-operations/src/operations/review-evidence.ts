import {custodyClient} from '../custody-client.js';
import {networkRoutes} from '../network-routes.js';
const address=(v:unknown)=>typeof v==='string'&&/^0x[0-9a-fA-F]{40}$/.test(v)?v.toLowerCase():null;
const units=(v:unknown)=>typeof v==='string'&&/^[0-9]{1,78}$/.test(v)?v:null;
/** Read-only allowlist: never include balances, private jobs, credentials or API errors. */
export function custodyEvidence(value:any){
 const p=value?.policy,t=value?.claus?.policy;
 if(value?.error||typeof value?.enabled!=='boolean'||value.chainId!==1||!p||!t||
  !address(value.address)||address(value.address)!==address(p.address)||!address(p.contract)||!address(t.contract)||!address(t.token)||
  !units(p.principal)||!units(p.perJob)||!units(p.gas)||!units(p.perTransactionGas)||!units(t.principal)||!units(t.perJob))return null;
 return {available:true,enabled:value.enabled,chainId:1,address:address(value.address),
  eth:{escrow:address(p.contract),perJob:p.perJob,cumulativePrincipal:p.principal},
  claus:{escrow:address(t.contract),token:address(t.token),perJob:t.perJob,cumulativePrincipal:t.principal},
  sharedGas:{asset:'ETH',cumulative:p.gas,perTransaction:p.perTransactionGas},
  scope:'Fixed Jobs escrows only. Token approval is exact and funding is separate. Withdrawal recipient is the same work wallet. No arbitrary transfer, general signing, token-owner or arbitration authority. Limits do not reset on deposits or refunds.',
  evidenceLevel:'current-service-policy-not-proof-of-a-payment'};
}
export function inferenceEvidence(value:any){
 const p=value?.inference;
 if(value?.error||!p||typeof p.enabled!=='boolean'||p.profile!=='claus-project-inference/2'||
  !Array.isArray(p.input)||p.input.some((v:unknown)=>!['text','conversation','inline-image'].includes(String(v)))||
  !Array.isArray(p.output)||p.output.some((v:unknown)=>!['text','function-calls'].includes(String(v)))||
  !Number.isSafeInteger(p.maxTools)||p.maxTools<0||p.maxTools>8||
  !Number.isSafeInteger(p.conversationLimitBytes)||p.conversationLimitBytes<0||p.conversationLimitBytes>65536||
  typeof p.images!=='boolean'||typeof p.tools!=='boolean'||typeof p.streaming!=='boolean'||typeof p.remoteImages!=='boolean'||typeof p.structuredOutput!=='boolean'||
  p.toolExecution!=='caller-owned-no-automatic-execution')return null;
 return {available:true,enabled:p.enabled,profile:p.profile,input:p.input,output:p.output,
  images:p.images,tools:p.tools,maxTools:p.maxTools,conversationLimitBytes:p.conversationLimitBytes,
  streaming:p.streaming,remoteImages:p.remoteImages,structuredOutput:p.structuredOutput,toolExecution:p.toolExecution,
  evidenceLevel:'current-public-capabilities-not-proof-of-a-project-grant-or-executed-inference'};
}
async function publicInferenceCapabilities(){
 const response=await fetch('https://claus-network-api.vercel.app/v1/public/capabilities',{redirect:'error',signal:AbortSignal.timeout(15000),headers:{accept:'application/json'}});
 if(!response.ok)throw Error('public_capabilities_unavailable');
 const reader=response.body?.getReader();if(!reader)throw Error('public_capabilities_unavailable');
 const parts:Uint8Array[]=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>64000){await reader.cancel();throw Error('public_capabilities_too_large');}parts.push(part.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}return JSON.parse(new TextDecoder().decode(bytes));
}
export async function operationalReviewEvidence(scope:string,{read=()=>custodyClient.tool({operation:'status',input:'{}'}),readInference=publicInferenceCapabilities,now=()=>Date.now(),paths=[]}:any={}){
 if(!['web','repository'].includes(scope))return {observedAt:new Date(now()).toISOString(),jobsWallet:{available:false,reason:'not_requested_for_scope'}};
 const needsInference=scope==='repository'||paths.some((p:unknown)=>typeof p==='string'&&/^docs\/(compute|inference)\.(md|html)$/.test(p));
 const [jobsWallet,projectInference]=await Promise.all([
  Promise.resolve().then(read).then(custodyEvidence).catch(()=>null),
  needsInference?Promise.resolve().then(readInference).then(inferenceEvidence).catch(()=>null):Promise.resolve(null)
 ]);
 return {observedAt:new Date(now()).toISOString(),source:'https://claus-inference.vercel.app/api/jobs/wallet',
  jobsWallet:jobsWallet??{available:false,reason:'current_service_evidence_unavailable'},
  ...(needsInference?{inference:{source:'https://claus-network-api.vercel.app/v1/public/capabilities',
   capabilities:projectInference??{available:false,reason:'current_public_capabilities_unavailable'},
   bundledSchema:{operation:'inference_submit',source:'runtime-generated-shared-network-contract',inputSchema:networkRoutes.inference_submit.inputSchema},
   meaning:'The capabilities are a fresh public API observation. The schema is the trusted runtime bundled contract, not an instruction from proposed source or proof of a completed request. Unavailable current capability evidence does not establish feature availability.'}}:{})};
}
