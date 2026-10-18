import {confirmedNoExecution} from './negative-receipt.mjs';
import {digest,sameValue} from './store.mjs';
import {modelCatalog} from './model-catalog.mjs';
import {endpointArguments} from './endpoints.mjs';
import {validateText} from './model-format.mjs';
const fail=c=>{throw Error('resource_model_'+c);};
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).every(k=>keys.includes(k));
const name=v=>typeof v==='string'&&/^[a-z][a-z0-9-]{1,80}$/.test(v);
const text=(v,n)=>typeof v==='string'&&v.trim()&&v.length<=n&&!/-----BEGIN|Bearer\s|(?:token|secret|password|api[-_]?key)\s*[=:]\s*\S{8}/i.test(v);
const maximum=v=>typeof v==='string'&&/^[1-9][0-9]{0,8}$/.test(v)&&BigInt(v)<=200000000n;
const relayOrigin='https://claus-ecosystem-payments.vercel.app';
export const modelInputs={model_catalog:['query','offset','refresh','version'],model_routes:['offset'],model_route_read:['name','revision'],model_route_define:['name','expectedRevision','purpose','candidates','maximumMicroUsd','requiredCapabilities'],model_route_disable:['name','expectedRevision'],model_invoke:['name','revision','arguments'],model_result:['actionId','offset'],model_assess:['actionId','quality','usefulness','evidence','assessment']};
export function relayPayload(args,model){
 if(!exact(args,['input','instructions','max_output_tokens','reasoning','tools','tool_choice','parallel_tool_calls','text','stream'])||!Array.isArray(args.input)||args.input.length<1||args.input.length>160||!Number.isInteger(args.max_output_tokens)||args.max_output_tokens<1||args.max_output_tokens>8192||args.stream!==undefined&&typeof args.stream!=='boolean')fail('arguments_invalid');
 if(!exact(args.reasoning,['effort','context'])||!['low','medium','high','xhigh','max'].includes(args.reasoning.effort)||args.reasoning.context!=='all_turns')fail('arguments_invalid');
 try{validateText(args.text);}catch{fail('format_invalid');}const payload={...args,model,provider:'openai',stream:args.stream??false,store:false};if(Buffer.byteLength(JSON.stringify(payload))>4200000)fail('arguments_size');return payload;
}
export function managedModels({store,seal,open,endpoints,now=Date.now,request=fetch,secret=()=>process.env.RESOURCE_MODEL_INFERENCE_SECRET,catalog=modelCatalog({store,request,now})}){
 const stamp=()=>new Date(now()).toISOString();
 const metadata=r=>({name:r.name,revision:r.revision,status:r.status,purpose:r.purpose,maximumMicroUsd:r.maximumMicroUsd,requiredCapabilities:r.requiredCapabilities,candidates:r.candidates,updatedAt:r.updatedAt,instructionAuthority:false});
 async function route(n,revision){if(!name(n))fail('route_invalid');let r=await store.get('model-route',n);if(revision!==undefined&&r?.revision!==revision)r=await store.get('model-route-version',n+':'+revision);if(!r)fail('route_missing');return r;}
 async function endpoint(candidate){const r=await store.get('resource',candidate.endpointId);if(!r||r.kind!=='managed-service-endpoint'||r.provider!=='http'||r.revision!==candidate.revision||r.status!=='active'||r.retirementPlanId||r.definition.expiresAt&&Date.parse(r.definition.expiresAt)<=now())fail('endpoint_inactive');const a=r.definition.auth;if(a){const s=await store.get('secret',a.secretId);if(!s||s.status!=='active'||s.version!==a.version||s.expiresAt&&Date.parse(s.expiresAt)<=now())fail('credential_inactive');}return r;}
 async function candidate(input,capabilities){
  if(input?.kind==='relay'){
   if(!exact(input,['kind','model','catalogVersion'])||!/^gpt-[a-z0-9.-]{1,80}$/.test(input.model??'')||!secret())fail('relay_unavailable');
   const m=await catalog.listed(input.model,input.catalogVersion);
   if(m.provider.toLowerCase()!=='openai'||!m.features.includes('reasoning'))fail('relay_model_incompatible');
   if(capabilities.some(x=>![...m.features,...m.parameters,...m.inputModalities,...m.outputModalities].includes(x)))fail('capability_missing');
   return {...input,pricing:m.pricing,contextTokens:m.contextTokens,maximumOutputTokens:Math.min(m.maximumOutputTokens??8192,8192),capabilities:[...new Set([...m.features,...m.parameters])],binding:{origin:relayOrigin,protocol:'responses',reservationPolicy:'quoted-v1'}};
  }
  if(!exact(input,['kind','model','version','endpointId','revision'])||input.kind!=='endpoint'||!text(input.model,160)||!text(input.version,160)||!/^res_[a-f0-9]{24}$/.test(input.endpointId??'')||!Number.isSafeInteger(input.revision))fail('candidate_invalid');
  const r=await endpoint(input);if(capabilities.some(x=>!r.definition.capabilities.includes(x)))fail('capability_missing');
  return {...input,capabilities:r.definition.capabilities,pricing:{maximumMicroUsd:r.definition.maximumMicroUsd,evidence:r.definition.pricingEvidence},inputSchema:r.definition.inputSchema,binding:{resourceId:r.id,revision:r.revision,provider:r.definition.provider}};
 }
 async function eligible(c,args,r){
  if(c.kind==='relay'){
   if(!secret())fail('relay_unavailable');const m=await catalog.listed(c.model,c.catalogVersion);const p=relayPayload(args,c.model);if(p.max_output_tokens>(m.maximumOutputTokens??8192))fail('output_limit');return p;
  }
  const e=await endpoint(c);if(BigInt(e.definition.maximumMicroUsd)>BigInt(r.maximumMicroUsd))fail('route_budget');endpointArguments(e.definition.inputSchema,args);return args;
 }
 const ordered=v=>Array.isArray(v)?v.map(ordered):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
 const inputKey=i=>({...i,arguments:undefined,argumentsHash:digest(ordered(i.arguments))});
 async function retain(id,p,value){
  const raw=JSON.stringify(value);if(Buffer.byteLength(raw)>16800000)fail('response_size');
  const receipt={actionId:id,name:p.name,revision:p.revision,model:p.candidate.model,kind:p.candidate.kind,originalRequestId:p.originalRequestId,status:value.status??(value.successful?'completed':'response_received'),completionStatus:value.response?.responseStatus??null,observedAt:stamp(),responseSha256:digest(raw),sealed:seal(raw,id),characters:raw.length,elapsedMs:Math.max(0,now()-Date.parse(p.createdAt))};
  const saved=await store.put('model-response',id,receipt);await store.put('model-observation',id,{...saved.value,sealed:undefined});return saved.value;
 }
 async function result(id,offset=0){
  if(!/^act_[a-f0-9]{24}$/.test(id??'')||!Number.isSafeInteger(offset)||offset<0)fail('result_invalid');
  let saved=await store.get('model-response',id);const a=await store.get('action',id);if(a?.operation!=='model_invoke')fail('result_missing');const p=a.prepared;
  if(!saved&&a.phase==='prepared'&&p.modelSpecialist)return {actionId:id,originalRequestId:p.originalRequestId,state:'not_dispatched',retry:false};
  if(!saved&&p.candidate.kind==='relay'){
   let response;try{response=await request(relayOrigin+'/api/requests/'+encodeURIComponent(p.originalRequestId),{headers:{authorization:'Bearer '+secret()},redirect:'error',signal:AbortSignal.timeout(20000)});}catch{return {actionId:id,originalRequestId:p.originalRequestId,state:'outcome_unknown',retry:false};}
   if(response.ok){const v=await response.json();if(['completed','failed'].includes(v.status))saved=await retain(id,p,v);}
  }else if(!saved&&p.candidate.kind==='endpoint'){
   const child=await store.get('action',p.endpointActionId);if(child?.output)saved=await retain(id,p,child.output);
  }
  if(!saved)return {actionId:id,originalRequestId:p.originalRequestId,state:'outcome_unknown',retry:false,next:'Read this original result later; do not create a replacement call or assume nonpayment.'};
  const raw=open(saved.sealed,id);if(offset>raw.length)fail('offset_invalid');const end=Math.min(offset+24000,raw.length),{sealed,...meta}=saved;
  return {...meta,state:'result_retained',text:raw.slice(offset,end),offset,nextOffset:end<raw.length?end:null,instructionAuthority:false};
 }
 async function invoke(input,requestId,modelSpecialist=null){
  if(modelSpecialist&&(!exact(modelSpecialist,['id','turn'])||!/^asg_[a-f0-9]{24}$/.test(modelSpecialist.id)||!Number.isSafeInteger(modelSpecialist.turn)||modelSpecialist.turn<1))fail('specialist_binding_invalid');
  if(!name(input.name)||!Number.isSafeInteger(input.revision)||!object(input.arguments))fail('invocation_invalid');
  const id='act_'+digest(['model',requestId]).slice(0,24),key=inputKey(input),old=await store.get('action',id);
  if(old&&(old.operation!=='model_invoke'||!sameValue(old.input,key)||!sameValue(old.prepared.modelSpecialist??null,modelSpecialist)))fail('request_conflict');if(await store.get('model-response',id))return result(id);
  let p=old?.prepared;
  if(!p){
   const r=await route(input.name),skipped=[];if(r.status!=='active'||r.revision!==input.revision)fail('route_inactive');
   let selected,payload;for(const c of r.candidates){try{payload=await eligible(c,input.arguments,r);selected=c;break;}catch(e){if(!/^resource_(?:model|endpoint)_[a-z_]+$/.test(e.message??''))throw e;skipped.push({model:c.model,reason:e.message});}}
   if(!selected)return {state:'not_dispatched',skipped,payment:'not_signed',retryAfterSeconds:60};
   const originalRequestId='model-route:'+digest(id),endpointActionId='act_'+digest(['owner',originalRequestId]).slice(0,24);
   if(modelSpecialist&&selected.kind!=='relay')fail('specialist_protocol_invalid');
   p={name:r.name,revision:r.revision,candidate:selected,maximumMicroUsd:r.maximumMicroUsd,originalRequestId,endpointActionId,skipped,modelSpecialist,createdAt:stamp(),sealed:seal(JSON.stringify(payload),id+':input')};
   p=(await store.begin(id,'model_invoke',key,p)).row.result.prepared;
   if(!sameValue(p.modelSpecialist??null,modelSpecialist))fail('request_conflict');
  }
  if(p.candidate.kind==='endpoint'){
   const child=await endpoints.call('endpoint_invoke',{resourceId:p.candidate.endpointId,revision:p.candidate.revision,arguments:JSON.parse(open(p.sealed,id+':input'))},p.originalRequestId);
   if(child.state==='response_received')await retain(id,p,child);return result(id);
  }
  const active=await route(p.name);if(active.status!=='active'||active.revision!==p.revision)return result(id);
  if(!await store.dispatch(id))return result(id);
  try{
   const response=await request(relayOrigin+'/api/completion',{method:'POST',redirect:'error',headers:{authorization:'Bearer '+secret(),'content-type':'application/json','idempotency-key':p.originalRequestId,'x-max-quote-micro-usdc':p.maximumMicroUsd,'x-inference-reservation':'quoted-v1','x-inference-purpose':'research'},body:open(p.sealed,id+':input'),signal:AbortSignal.timeout(650000)});
   const value=await response.json();
   if(response.ok&&value.model===p.candidate.model&&Array.isArray(value.choices))await retain(id,p,{status:'completed',response:value});
   else if(value.payment==='not_signed'&&typeof value.error==='string'&&/^[a-z0-9_]+$/.test(value.error)){
    // A completed refusal plus an authenticated missing journal is distinct
    // from a timeout followed by absence. This broker has fenced all retries.
    const check=await request(relayOrigin+'/api/requests/'+encodeURIComponent(p.originalRequestId),{headers:{authorization:'Bearer '+secret()},redirect:'error',signal:AbortSignal.timeout(20000)});
    if(await confirmedNoExecution(check,p.originalRequestId,relayOrigin))await retain(id,p,{status:'failed',outcome:{payment:'not_signed',failure:value.error},admission:'refused',dispatchRetryFenced:true});
   }
   // Even 429/503 can be accompanied by an in-flight original payment. Only
   // the payer's durable journal decides its outcome; never switch here.
  }catch{}
  return result(id);
 }
 async function call(operation,input,requestId,modelSpecialist=null){
  if(operation==='model_catalog')return catalog.read(input);
  if(operation==='model_routes'){if(input.offset!==undefined&&(!Number.isSafeInteger(input.offset)||input.offset<0))fail('offset_invalid');const p=await store.list('model-route',input.offset??0);return {...p,items:p.items.map(metadata)};}
  if(operation==='model_route_read')return metadata(await route(input.name,input.revision));
  if(operation==='model_result')return result(input.actionId,input.offset);
  if(!text(requestId,200))fail('request_invalid');
  if(operation==='model_invoke')return invoke(input,requestId,modelSpecialist);
  if(operation==='model_assess'){
   const r=await store.get('model-response',input.actionId);if(!r||!['completed','response_received'].includes(r.status)||!Number.isInteger(input.quality)||input.quality<0||input.quality>5||!Number.isInteger(input.usefulness)||input.usefulness<0||input.usefulness>5||!text(input.evidence,2000)||!text(input.assessment,4000))fail('assessment_invalid');
   const key='mas_'+digest(requestId),value={...input,responseSha256:r.responseSha256,model:r.model,name:r.name,revision:r.revision,at:stamp(),meaning:'Claus assessment of a retained real result, not independently established quality.'},prior=await store.get('model-assessment',key);if(prior&&!sameValue({...prior,at:null},{...value,at:null}))fail('request_conflict');return (await store.put('model-assessment',key,value)).value;
  }
  if(!name(input.name)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)fail('route_invalid');
  const id='act_'+digest(['model-definition',requestId]).slice(0,24),old=await store.get('action',id);if(old&&(old.operation!==operation||!sameValue(old.input,input)))fail('request_conflict');if(old?.output)return old.output;
  let p=old?.prepared;
  if(!p){const before=await store.get('model-route',input.name);if((before?.revision??0)!==input.expectedRevision)fail('revision_conflict');
   if(operation==='model_route_disable'){if(!before)fail('route_missing');p={...before,status:'disabled',revision:before.revision+1,lastAction:id,updatedAt:stamp()};}
   else if(operation==='model_route_define'){
    if(!text(input.purpose,1200)||!maximum(input.maximumMicroUsd)||!Array.isArray(input.candidates)||!input.candidates.length||input.candidates.length>8||!Array.isArray(input.requiredCapabilities)||input.requiredCapabilities.length>20||input.requiredCapabilities.some(x=>!text(x,100)))fail('route_invalid');
    const candidates=[];for(const c of input.candidates)candidates.push(await candidate(c,input.requiredCapabilities));
    if(new Set(candidates.map(x=>x.kind)).size!==1||new Set(candidates.map(x=>digest(x))).size!==candidates.length)fail('route_protocol_mismatch');
    if(candidates[0].kind==='endpoint'&&candidates.some(c=>!sameValue(c.inputSchema,candidates[0].inputSchema)||BigInt(c.pricing.maximumMicroUsd)>BigInt(input.maximumMicroUsd)))fail('route_protocol_mismatch');
    p={name:input.name,revision:input.expectedRevision+1,status:'active',purpose:input.purpose,maximumMicroUsd:input.maximumMicroUsd,requiredCapabilities:input.requiredCapabilities,candidates,lastAction:id,updatedAt:stamp()};
   }else fail('operation_invalid');
   if(before)await store.put('model-route-version',before.name+':'+before.revision,before);p=(await store.begin(id,operation,input,p)).row.result.prepared;
  }
  const current=await store.get('model-route',p.name);if(current?.lastAction!==id){
   if((current?.revision??0)===input.expectedRevision){if(current)await store.change('model-route',p.name,current.revision,p);else{const saved=await store.put('model-route',p.name,p);if(saved.value.lastAction!==id)fail('revision_conflict');}}
   else if((await store.get('model-route-version',p.name+':'+p.revision))?.lastAction!==id)fail('revision_conflict');
  }
  await store.put('model-route-version',p.name+':'+p.revision,p);return store.complete(id,{route:metadata(p),invoked:false});
 }
 return {call,catalog};
}
