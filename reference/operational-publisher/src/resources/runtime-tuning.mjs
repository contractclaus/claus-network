import {configurationService} from '../configuration/service.js';
import {digest,sameValue} from './store.mjs';
const fail=c=>{throw Error('resource_runtime_'+c);};
const fields=['reasoningEffort','maxActionsPerTurn','maxOutputTokens'];
const visible=r=>({revision:r.revision,hash:r.hash,settings:Object.fromEntries(fields.map(k=>[k,r.content.settings[k]])),model:r.content.settings.model,provider:r.content.settings.provider});
export const tuningInputs={runtime_settings:['revision'],runtime_tune:['expectedRevision','workId','patch','reason']};
export function tuningPatch(patch){
 if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length||Object.keys(patch).some(k=>!fields.includes(k)))fail('patch_invalid');
 if(patch.reasoningEffort!==undefined&&!['low','medium','high','xhigh','max'].includes(patch.reasoningEffort))fail('reasoning_invalid');
 if(patch.maxActionsPerTurn!==undefined&&(!Number.isInteger(patch.maxActionsPerTurn)||patch.maxActionsPerTurn<1||patch.maxActionsPerTurn>24))fail('chunk_invalid');
 if(patch.maxOutputTokens!==undefined&&(!Number.isInteger(patch.maxOutputTokens)||patch.maxOutputTokens<256||patch.maxOutputTokens>8192))fail('output_invalid');
 return patch;
}
export function runtimeTuning({store,workStatus,configuration,now=Date.now}){
 const config=()=>configuration??=configurationService();
 return {async call(operation,input,requestId){
  if(operation==='runtime_settings')return {...visible(await config().read(input.revision)),editable:fields,limits:{reasoningEffort:['low','medium','high','xhigh','max'],maxActionsPerTurn:[1,24],maxOutputTokens:[256,8192]},meaning:'Continuation chunk and current connected model protocol limits; not a total work limit. Owner policy and budgets are separately enforced.'};
  if(operation!=='runtime_tune')fail('operation_invalid');
  tuningPatch(input.patch);
  if(typeof requestId!=='string'||!requestId||requestId.length>200||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||!/^nw_[a-z0-9_-]{1,80}$/.test(input.workId??'')||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>1200||/-----BEGIN|Bearer\s|(?:token|secret|password)\s*[=:]\s*\S{8}/i.test(input.reason))fail('request_invalid');
  const id='act_'+digest(['runtime-tuning',requestId]).slice(0,24),prior=await store.get('action',id);
  if(prior&&(prior.operation!==operation||!sameValue(prior.input,input)))fail('request_conflict');
  if(prior?.output)return prior.output;
  const original=await config().read(input.expectedRevision),candidate={...original.content,settings:{...original.content.settings,...input.patch}},targetHash=config().hash(candidate);
  const complete=async row=>{const result={id,...visible(row),workId:input.workId,reason:input.reason,actor:'claus-runtime',recordedAt:new Date(now()).toISOString(),takesEffect:'Subsequent execution chunks; current work is not restarted',protectedPolicyChanged:false};return store.complete(id,result);};
  if(!prior)await store.begin(id,operation,input,{expectedRevision:input.expectedRevision,targetHash});
  // Reconcile the original committed child even if later configuration changes
  // have already happened. Never replay a change against a newer owner revision.
  const child=await config().childOf(input.expectedRevision);
  if(child?.hash===targetHash)return complete(child);
  const latest=await config().read(),s=latest.content.settings;
  if(latest.revision!==input.expectedRevision)fail('revision_conflict');
  if(s.enabled!==true||s.role!=='operator'||s.networkOperations?.enabled!==true||latest.content.policy.capabilities.networkBuild!==true||!['ready','working','waiting'].includes(await workStatus(input.workId)))fail('inactive');
  if(latest.hash===targetHash)return complete(latest);
  try{await config().update({configuration:candidate,expectedRevision:input.expectedRevision},'claus-runtime');}
  catch(error){const recovered=await config().childOf(input.expectedRevision);if(recovered?.hash===targetHash)return complete(recovered);throw error;}
  const applied=await config().childOf(input.expectedRevision);if(applied?.hash!==targetHash)fail('outcome_unknown');return complete(applied);
 }};
}
