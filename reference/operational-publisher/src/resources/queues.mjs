import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {digest} from './store.mjs';
import {endpointArguments} from './endpoints.mjs';
const fail=c=>{throw Error('resource_queue_'+c);};
const activeWork=s=>['ready','working','waiting'].includes(s);
const terminal=new Set(['succeeded','accepted','failed','cancelled']);
const runnable=['queued','waiting','running','reconciling'];
const text=(s,n)=>typeof s==='string'&&s.trim().length>0&&s.length<=n;
const integer=(v,a,b)=>Number.isSafeInteger(v)&&v>=a&&v<=b;
export const queueInputs={
 queue_create:['name','purpose','workId','endpointId','endpointRevision','concurrency'],
 queue_update:['resourceId','expectedRevision','enabled','concurrency'],
 queue_info:['resourceId'],queue_jobs:['resourceId','states','offset'],
 queue_enqueue:['resourceId','arguments','dependsOn','notBefore'],
 queue_run:['resourceId','jobId'],queue_cancel:['resourceId','jobId','expectedRevision'],
 queue_webhook:['resourceId','expectedRevision','secretId','version','enabled']
};
export function managedQueues({store,endpoints,workStatus,open,now=Date.now}){
 const stamp=()=>new Date(now()).toISOString();
 const key=(q,j)=>q+':'+j;
 const view=j=>{const {argumentsSealed,...rest}=j;return {...rest,instructionAuthority:false,receiptMeaning:'Queue delivery state and original endpoint receipt; HTTP acceptance is not completion of an asynchronous external task.'};};
 async function queue(id){const q=await store.get('queue',id);if(!q)fail('not_found');return q;}
 async function endpoint(q){const r=await store.get('resource',q.endpointId);if(!r||r.provider!=='http'||r.status!=='active'||r.revision!==q.endpointRevision)fail('endpoint_changed');return r;}
 async function job(q,id){if(!/^job_[a-f0-9]{24}$/.test(id??''))fail('job_invalid');const j=await store.get('job',key(q.id,id));if(!j)fail('job_not_found');return j;}
 async function secret(q){const s=q.webhook&&await store.get('secret',q.webhook.secretId);if(!s||!['application','external-service'].includes(s.kind)||s.status!=='active'||s.version!==q.webhook.version||s.expiresAt&&Date.parse(s.expiresAt)<=now())fail('webhook_unavailable');return open(s.sealed,s.id+':'+s.version);}
 async function saveJob(q,j,changes){const v={...j,...changes,revision:j.revision+1,updatedAt:stamp()};await store.change('job',key(q.id,j.id),j.revision,v);await store.put('job-history',key(q.id,j.id)+':'+v.revision,view(v));return v;}
 async function enqueue(q,input,requestId,seal){
  q=await queue(q.id);const own=await store.get('resource',q.id);if(own?.retirementPlanId||!q.enabled||!activeWork(await workStatus(q.workId)))fail('inactive');
  const schema=q.delivery==='pull'?q.inputSchema:(await endpoint(q)).definition.inputSchema;endpointArguments(schema,input.arguments);
  const raw=JSON.stringify(input.arguments);if(Buffer.byteLength(raw)>1000000)fail('arguments_too_large');
  const dependencies=input.dependsOn??[];if(!Array.isArray(dependencies)||dependencies.length>100||new Set(dependencies).size!==dependencies.length)fail('dependencies_invalid');
  for(const id of dependencies)await job(q,id);
  const nextAt=input.notBefore??stamp();if(!Number.isFinite(Date.parse(nextAt)))fail('time_invalid');
  const id='job_'+digest([q.id,requestId]).slice(0,24),inputHash=digest({arguments:input.arguments,dependencies,notBefore:input.notBefore??null});
  const old=await store.get('job',key(q.id,id));if(old){if(old.inputHash!==inputHash)fail('request_conflict');return view(old);}
  const v={id,resourceId:q.id,workId:q.workId,endpointId:q.endpointId,endpointRevision:q.endpointRevision,inputHash,argumentsSealed:seal(raw,key(q.id,id)),dependencies,nextAt,state:'queued',checks:0,revision:1,originalRequestId:'queue:'+q.id+':'+id,createdAt:stamp(),updatedAt:stamp()};
  const saved=await store.put('job',key(q.id,id),v);if(saved.value.inputHash!==inputHash)fail('request_conflict');return view(saved.value);
 }
 async function run(q,id,{manual=false}={}){
  if(q.delivery==='pull')fail('pull_worker_required');
  let j=await job(q,id);if(terminal.has(j.state)||j.state==='blocked'&&!manual)return view(j);
  if(j.leaseUntil>now())return {...view(j),busy:true};
  const originalId='act_'+digest(['owner',j.originalRequestId]).slice(0,24),original=await store.get('endpoint-response',originalId);
  if(original){const successful=original.status>=200&&original.status<300;return view(await saveJob(q,j,{state:original.status===202?'accepted':successful?'succeeded':'failed',receipt:{actionId:originalId,httpStatus:original.status,responseSha256:original.digest,observedAt:original.at},reason:successful?null:'endpoint_response_'+original.status,leaseUntil:null,leaseToken:null}));}
  q=await queue(q.id);
  if(q.retirementPlanId||!q.enabled||!activeWork(await workStatus(q.workId)))return view(await saveJob(q,j,{state:'blocked',reason:'work_or_queue_inactive',leaseUntil:null}));
  if(!manual&&Date.parse(j.nextAt)>now())return view(j);
  for(const dep of j.dependencies){const d=await job(q,dep);if(d.state!=='succeeded')return view(await saveJob(q,j,{state:terminal.has(d.state)||d.state==='blocked'?'blocked':'waiting',reason:'dependency_'+d.state,nextAt:new Date(now()+60000).toISOString()}));}
  try{await endpoint(q);}catch(e){if(e.message==='resource_queue_endpoint_changed')return view(await saveJob(q,j,{state:'blocked',reason:'endpoint_changed'}));throw e;}
  // Reserve request concurrency with CAS before claiming a job. Expired slots
  // are bounded by the endpoint's 60 second request timeout, never re-dispatch.
  q=await queue(q.id);const slots=(q.slots??[]).filter(x=>x.until>now());
  if(slots.length>=q.concurrency)return {...view(j),capacityWait:true};
  const token=randomUUID(),until=now()+180000;
  await store.change('queue',q.id,q.revision,{...q,slots:[...slots,{jobId:id,token,until}],revision:q.revision+1});
  try{j=await saveJob(q,j,{state:'running',leaseToken:token,leaseUntil:until,checks:j.checks+1});}
  catch(e){await release(q.id,token);throw e;}
  const actionId='act_'+digest(['owner',j.originalRequestId]).slice(0,24);
  let changes;
  try{
   const result=await endpoints.call('endpoint_invoke',{resourceId:j.endpointId,revision:j.endpointRevision,arguments:JSON.parse(open(j.argumentsSealed,key(q.id,id)))},j.originalRequestId);
   if(result.state==='response_received')changes={state:result.httpStatus===202?'accepted':result.successful?'succeeded':'failed',receipt:{actionId,httpStatus:result.httpStatus,responseSha256:result.responseSha256,observedAt:result.observedAt},reason:result.successful?null:'endpoint_response_'+result.httpStatus};
   else changes={state:j.checks>=3?'blocked':'reconciling',reason:'original_response_unknown',receipt:{actionId},nextAt:new Date(now()+180000).toISOString()};
  }catch(e){
   const action=await store.get('action',actionId),sent=action?.phase==='dispatched';
   changes={state:j.checks>=6?'blocked':sent?'reconciling':'waiting',reason:sent?'original_response_unknown':/^resource_[a-z0-9_]+$/.test(e.message)?e.message:'endpoint_preflight_unavailable',receipt:{actionId},nextAt:new Date(now()+Math.min(3600000,60000*2**Math.min(j.checks,6))).toISOString()};
  }
  try{const current=await job(q,id);if(current.leaseToken!==token)fail('lease_lost');return view(await saveJob(q,current,{...changes,leaseToken:null,leaseUntil:null}));}
  finally{await release(q.id,token);}
 }
 async function release(id,token){for(let i=0;i<3;i++){const q=await queue(id);if(!q.slots?.some(x=>x.token===token))return;try{await store.change('queue',id,q.revision,{...q,slots:q.slots.filter(x=>x.token!==token),revision:q.revision+1});return;}catch(e){if(e.message!=='resource_revision_conflict')throw e;}}}
 async function call(operation,input,requestId,seal){
  if(!text(requestId,200)&&!['queue_info','queue_jobs'].includes(operation))fail('request_invalid');
  if(operation==='queue_create'){
   if(!/^[a-z][a-z0-9-]{1,40}$/.test(input.name??'')||!text(input.purpose,350)||!/^nw_[a-z0-9_-]{1,80}$/.test(input.workId??'')||!activeWork(await workStatus(input.workId))||!integer(input.concurrency??1,1,100))fail('definition_invalid');
   const id='res_'+digest(['queue',requestId]).slice(0,24),v={id,name:input.name,purpose:input.purpose,workId:input.workId,endpointId:input.endpointId,endpointRevision:input.endpointRevision,concurrency:input.concurrency??1,enabled:true,slots:[],revision:1,provider:'internal',kind:'managed-queue',owner:'Claus',providerId:id,createdAt:stamp(),inputHash:digest(input)};
   await endpoint(v);const saved=await store.put('queue',id,v);if(saved.value.inputHash!==v.inputHash)fail('request_conflict');await store.put('resource',id,v);return {resource:saved.value};
  }
  let q=await queue(input.resourceId);
  if(operation==='queue_info')return {...q,activeRequests:(q.slots??[]).filter(x=>x.until>now()).length};
  if(operation==='queue_jobs'){
   const states=input.states??[];if(!Array.isArray(states)||states.some(x=>![...runnable,...terminal,'blocked'].includes(x))||!integer(input.offset??0,0,10000000))fail('page_invalid');
   const p=await store.jobs(q.id,states,input.offset??0);return {...p,items:p.items.map(view)};
  }
  if(operation==='queue_enqueue')return enqueue(q,input,requestId,seal);
  if(operation==='queue_run')return run(q,input.jobId,{manual:true});
  if(operation==='queue_cancel'){
   const j=await job(q,input.jobId);if(j.state==='cancelled')return view(j);if(j.revision!==input.expectedRevision)fail('revision_conflict');
   const action=await store.get('action','act_'+digest(['owner',j.originalRequestId]).slice(0,24));
   if(j.worker||j.leaseUntil>now()||action?.phase==='dispatched'||terminal.has(j.state))fail('original_response_must_be_reconciled');
   return view(await saveJob(q,j,{state:'cancelled',reason:'owner_cancelled_before_dispatch'}));
  }
  const requestHash=digest({operation,input});if(q.lastChange===requestHash)return q;
  if(q.revision!==input.expectedRevision)fail('revision_conflict');
  if(operation==='queue_update'){
   if(typeof input.enabled!=='boolean'||!integer(input.concurrency,1,100))fail('definition_invalid');
   q={...q,enabled:input.enabled,concurrency:input.concurrency};
  }else if(operation==='queue_webhook'){
   if(typeof input.enabled!=='boolean')fail('definition_invalid');
   q={...q,webhook:input.enabled?{secretId:input.secretId,version:input.version}:null};if(input.enabled)await secret(q);
  }else fail('operation_invalid');
  const value={...q,revision:q.revision+1,lastChange:requestHash,updatedAt:stamp()};await store.change('queue',q.id,q.revision,value);return value;
 }
 async function webhook(id,{timestamp,eventId,signature,raw},seal){
  if(!/^res_[a-f0-9]{24}$/.test(id??'')||!/^\d{10}$/.test(timestamp??'')||Math.abs(now()-Number(timestamp)*1000)>300000||! /^[A-Za-z0-9_.:-]{1,100}$/.test(eventId??'')||! /^[a-f0-9]{64}$/.test(signature??'')||typeof raw!=='string'||Buffer.byteLength(raw)>1000000)fail('webhook_invalid');
  const q=await queue(id),value=await secret(q),expected=createHmac('sha256',value).update(timestamp+'.'+eventId+'.'+raw).digest();
  if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))fail('webhook_invalid');
  // Sender-controlled data can only become arguments to this fixed endpoint.
  return enqueue(q,{arguments:JSON.parse(raw)},'webhook:'+id+':'+eventId,seal);
 }
 async function tick(){
  const cursor=await store.get('queue-cursor','main'),page=await store.list('queue',cursor?.offset??0),results=[];
  for(const q of page.items){if(!q.enabled||q.delivery==='pull')continue;const jobs=await store.jobs(q.id,runnable,0,true);for(const j of jobs.items){if(results.length>=4)break;try{results.push(await run(q,j.id));}catch(e){results.push({resourceId:q.id,jobId:j.id,state:'inspection_failed',reason:/^resource_[a-z0-9_]+$/.test(e.message)?e.message:'resource_queue_unavailable'});}}if(results.length>=4)break;}
  // Rotate by queue even when one has a large backlog. Jobs are ordered by
  // next eligible time, so terminal history cannot starve new requests.
  const advance=results.length>=4?Math.min((cursor?.offset??0)+1,(cursor?.offset??0)+page.items.length):page.nextOffset??0;
  const next={offset:page.items.length?advance:0,revision:(cursor?.revision??0)+1};
  if(cursor)await store.change('queue-cursor','main',cursor.revision,next);else await store.put('queue-cursor','main',next);
  return {processed:results.length,results};
 }
 return {call,webhook,tick};
}
