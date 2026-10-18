import {digest,sameValue} from './store.mjs';
import {team,owner} from './providers.mjs';
const fail=c=>{throw Error('resource_retirement_'+c);};
const ref=v=>typeof v==='string'&&/^res_[a-f0-9]{24}$/.test(v);
const clean=v=>typeof v==='string'&&v.trim().length>0&&v.length<=2000&&!/-----BEGIN|Bearer\s|(?:password|token|secret|api[-_]?key)\s*[=:]\s*\S{8}/i.test(v);
const protectedIds=new Set(['prj_JQEQJQb3Obhgas8Dtx0FIe1Zokah','prj_rGom8c2zwC8zztmqsSFPaAJj7fXs','prj_a90aDFMUDMWMXH3RKYX87ZhgOeno','prj_3EPhg3tuhf5oHU9sw2Butj9eRegy','prj_ga967O1Jesuhqi69WxXCGhuYxH7Q']);
const terminal=new Set(['succeeded','failed','cancelled']);
const frozen=new Set(['retiring','retired','removed','archived']);
export const retirementInputs={retirement_inventory:['resourceId'],retirement_prepare:['resourceId','expectedRevision','reason','disposition'],retirement_read:['planId'],retirement_apply:['planId']};
export function resourceReferences(value,out=new Set()){
 if(ref(value))out.add(value);else if(Array.isArray(value))for(const v of value)resourceReferences(v,out);else if(value&&typeof value==='object')for(const v of Object.values(value))resourceReferences(v,out);return [...out];
}
export async function assertResourcesActive(store,value){for(const id of resourceReferences(value)){const r=await store.get('resource',id);if(r&&(r.retirementPlanId||frozen.has(r.status)))fail('resource_fenced');}}
export function managedRetirement({store,providers,invoke,now=Date.now}){
 const stamp=()=>new Date(now()).toISOString();
 async function all(kind){const rows=[];let offset=0;do{const p=await store.list(kind,offset);rows.push(...p.items);offset=p.nextOffset;}while(offset!==null);return rows;}
 async function resource(id){if(!ref(id))fail('reference_invalid');const r=await store.get('resource',id);if(!r||r.protected||protectedIds.has(r.providerId)||!r.creationAction&&r.kind!=='managed-queue'&&r.kind!=='managed-http-endpoint')fail('scope_denied');if(!['vercel','github','http','internal','r2','runpod','postgresql'].includes(r.provider))fail('provider_unsupported');return r;}
 async function inventory(id){
  const r=await resource(id),[queues,services,secrets,bindings,objects,assets,actions]=await Promise.all(['queue','service','secret','binding','object','asset','action'].map(all));
  const relatedQueues=queues.filter(q=>q.id===id||q.endpointId===id),jobs=[];
  for(const q of relatedQueues){let offset=0;do{const p=await store.jobs(q.id,[],offset);jobs.push(...p.items.map(j=>({resourceId:q.id,id:j.id,state:j.state,revision:j.revision,leaseUntil:j.leaseUntil??0,originalRequestId:j.originalRequestId})));offset=p.nextOffset;}while(offset!==null);}
  const pending=[];
  for(const a of actions){if(a.operation?.startsWith('retirement_')||a.output||a.phase!=='dispatched'||!resourceReferences([a.input,a.prepared]).includes(id))continue;pending.push({actionId:a.actionId,operation:a.operation,phase:a.phase});}
  return {resource:{id:r.id,provider:r.provider,providerId:r.providerId,name:r.name,kind:r.kind,revision:r.revision,status:r.status??'active'},queues:relatedQueues.map(q=>({id:q.id,revision:q.revision,enabled:q.enabled,workId:q.workId})),jobs,services:services.filter(s=>resourceReferences(s.targets).includes(id)).map(s=>({name:s.name,revision:s.revision,enabled:s.enabled})),grants:secrets.filter(s=>s.kind==='broker-grant'&&s.status==='active'&&s.rules?.resourceIds?.includes(id)).map(s=>({id:s.id,revision:s.revision,resourceIds:s.rules.resourceIds})),bindings:bindings.filter(b=>b.resourceId===id).map(b=>({envName:b.envName,secretId:b.secretId,version:b.version,status:b.status})),objects:objects.filter(o=>o.resourceId===id&&o.state!=='removed').map(o=>({id:o.id,state:o.state,sha256:o.sha256,bytes:o.bytes,expiresAt:o.expiresAt})),assets:assets.filter(a=>a.status==='active'&&a.files.some(f=>f.resourceId===id)).map(a=>({name:a.name,version:a.version,revision:a.revision})),pendingActions:pending,observedAt:stamp(),historyWillBeRetained:true,externalSubscriptionsIncluded:false};
 }
 async function proof(r,d){
  if(!d||typeof d!=='object'||Array.isArray(d))fail('disposition_required');
  if(d.kind==='retain'&&Object.keys(d).length===1)return {kind:'retain',remainingCosts:'Retained data, objects, packages and external subscriptions keep their existing billing and retention.'};
  if(d.kind==='discard'&&Object.keys(d).length===2&&clean(d.reason))return {kind:'discard',reason:d.reason,backupVerified:false};
  if(d.kind!=='export'||Object.keys(d).length!==3||!/^[a-z][a-z0-9-]{1,99}$/.test(d.name??'')||!/^[a-f0-9]{64}$/.test(d.version??''))fail('disposition_invalid');
  const a=await store.get('asset-version',d.name+':'+d.version),p=await store.get('asset-publication',d.name+':'+d.version);
  if(!a||!p||!a.files?.length)fail('published_export_required');
  for(const f of a.files){const o=await store.get('object',f.objectId),bucket=await store.get('resource',f.resourceId);if(f.resourceId===r.id||bucket?.status==='removed'||!o||o.resourceId!==f.resourceId||o.state!=='ready'||o.sha256!==f.sha256||o.bytes!==f.bytes||Date.parse(o.expiresAt)<=now())fail('export_unavailable');}
  return {kind:'export',name:a.name,version:a.version,files:a.files,expiresAt:a.expiresAt,meaning:'Verified exported bytes. Application-level completeness remains the declaring owner’s responsibility; R2 removal additionally checks every tracked object hash and size.'};
 }
 async function read(planId){if(!/^ret_[a-f0-9]{24}$/.test(planId??''))fail('plan_invalid');const p=await store.get('retirement',planId);if(!p)fail('plan_missing');return p;}
 async function save(p,patch){return store.change('retirement',p.id,p.revision,{...p,...patch,revision:p.revision+1,updatedAt:stamp()});}
 async function providerState(r){
  if(r.provider==='vercel'){const v=await providers.call('vercel','/v9/projects/'+encodeURIComponent(r.providerId),{missing:true});if(v&&(v.id!==r.providerId||v.accountId!==team))fail('provider_identity_changed');return v?{present:true,id:v.id}:null;}
  if(r.provider==='github'){const v=await providers.call('github','/repos/'+owner+'/'+encodeURIComponent(r.name),{missing:true});if(!v||String(v.id)!==r.providerId||v.owner?.login!==owner)fail('provider_identity_changed');return {present:true,id:String(v.id),archived:v.archived===true};}
  return {present:true};
 }
 async function child(p,name,operation,input){
  const key=p.id+':'+name,requestId=key;
  const step=(await store.put('retirement-step',key,{planId:p.id,operation,input,requestId,actionId:'act_'+digest(['owner',requestId]).slice(0,24)})).value;
  if(step.operation!==operation)fail('step_conflict');return invoke(step.operation,step.input,step.requestId);
 }
 async function apply(planId){
  let p=await read(planId);if(p.state==='completed')return p;
  let r=await resource(p.resourceId);
  if(!r.retirementPlanId){if(r.revision!==p.resourceRevision||frozen.has(r.status))fail('resource_changed');r=await store.change('resource',r.id,r.revision,{...r,status:'retiring',retirementPlanId:p.id,retiringAt:stamp(),revision:r.revision+1});}
  if(r.retirementPlanId!==p.id)fail('different_retirement');
  let v=await inventory(r.id);
  // Quiesce only the dependencies recorded in the fresh owned inventory. The
  // resource fence prevents new broker dispatches; history and holds stay put.
  for(const q of v.queues){const row=await store.get('queue',q.id);if(row.enabled||row.webhook)await store.change('queue',q.id,row.revision,{...row,enabled:false,webhook:null,retirementPlanId:p.id,revision:row.revision+1,updatedAt:stamp()});}
  for(const s of v.services){const row=await store.get('service',s.name);if(row.enabled)await store.change('service',s.name,row.revision,{...row,enabled:false,retirementPlanId:p.id,revision:row.revision+1,updatedAt:stamp()});}
  for(const g of v.grants){const row=await store.get('secret',g.id);if(row.rules.resourceIds.includes(r.id))await store.change('secret',g.id,row.revision,{...row,rules:{...row.rules,resourceIds:row.rules.resourceIds.filter(id=>id!==r.id)},revision:row.revision+1,updatedAt:stamp()});}
  const unresolved=[];
  for(const j of v.jobs){
   if(terminal.has(j.state))continue;
   const actionId='act_'+digest(['owner',j.originalRequestId]).slice(0,24),a=await store.get('action',actionId),response=await store.get('endpoint-response',actionId);
   if(j.leaseUntil>now()){unresolved.push({queueId:j.resourceId,jobId:j.id,reason:'active_lease'});continue;}
   if(response&&j.state!=='accepted'){await invoke('queue_run',{resourceId:j.resourceId,jobId:j.id},p.id+':reconcile:'+j.id);continue;}
   if(j.state==='accepted'||a?.phase==='dispatched'){unresolved.push({queueId:j.resourceId,jobId:j.id,actionId,reason:j.state==='accepted'?'asynchronous_completion_unproven':'original_response_unknown'});continue;}
   await invoke('queue_cancel',{resourceId:j.resourceId,jobId:j.id,expectedRevision:j.revision},p.id+':cancel:'+j.id);
  }
  const ownSteps=new Set((await all('retirement-step')).filter(x=>x.planId===p.id).map(x=>x.actionId));
  const pendingActions=[];
  for(const a of v.pendingActions){
   if(ownSteps.has(a.actionId))continue;
   if(a.operation==='endpoint_invoke'&&await store.get('endpoint-response',a.actionId)){await invoke('endpoint_reconcile',{resourceId:r.id,actionId:a.actionId},p.id+':receipt:'+a.actionId);continue;}
   pendingActions.push(a);
  }
  if(unresolved.length||pendingActions.length)return save(p,{state:'waiting',reason:'original_work_must_be_reconciled',unresolved,pendingActions});
  const drainUntil=Date.parse(r.retiringAt)+180000;
  if(now()<drainUntil)return save(p,{state:'draining',retryAt:new Date(drainUntil).toISOString(),reason:'allow_preexisting_requests_to_settle'});
  const d=await proof(r,p.disposition);
  if(r.provider==='postgresql')return save(p,{state:'blocked',reason:'database_export_and_session_shutdown_required',next:'Keep this plan and data. Database credentials alone do not terminate existing sessions; no schema is dropped or claimed retired.'});
  if(r.kind==='managed-network-volume'){
   if(d.kind==='retain')return save(p,{state:'blocked',reason:'volume_requires_explicit_export_or_discard',remainingCosts:d.remainingCosts});
   const result=await child(p,'volume','volume_delete',{resourceId:r.id,expectedRevision:r.revision,disposition:d.kind==='export'?{kind:'backed-up',name:d.name,version:d.version}:{kind:'discard',reason:d.reason}});
   if(!result.removed&&result.resource?.status!=='removed')return save(p,{state:'waiting',providerResult:result});
  }else if(r.provider==='r2'){
   if(d.kind==='retain')return save(p,{state:'blocked',reason:'bucket_data_retained',remainingCosts:d.remainingCosts});
   if(v.assets.length)return save(p,{state:'blocked',reason:'active_assets_use_bucket',assets:v.assets});
   for(const o of v.objects){if(d.kind==='export'&&!d.files.some(f=>f.sha256===o.sha256&&f.bytes===o.bytes))return save(p,{state:'blocked',reason:'export_missing_object',objectId:o.id});await child(p,'object:'+o.id,'object_remove',{resourceId:r.id,objectId:o.id});}
   const result=await child(p,'bucket','bucket_remove',{resourceId:r.id});if(!result.removed)return save(p,{state:'waiting',providerResult:result});
  }else if(r.provider==='vercel'||r.provider==='github'){
   if(r.provider==='vercel'&&d.kind==='retain')return save(p,{state:'blocked',reason:'project_export_or_explicit_discard_required'});
   let state=await providerState(r);
   if((r.provider==='vercel'&&state)||(r.provider==='github'&&!state.archived)){
    const actionId='act_'+digest(['retirement',p.id]).slice(0,24);
    await store.begin(actionId,'retirement_provider',{planId:p.id,resourceId:r.id},{resource:r});
    if(await store.dispatch(actionId)){
     if(r.provider==='vercel')await providers.call('vercel','/v9/projects/'+encodeURIComponent(r.providerId),{method:'DELETE'});
     else await providers.call('github','/repos/'+owner+'/'+encodeURIComponent(r.name),{method:'PATCH',body:{archived:true}});
    }
    state=await providerState(r);
    if((r.provider==='vercel'&&state)||(r.provider==='github'&&!state.archived))return save(p,{state:'waiting',reason:'original_provider_result_unknown',actionId});
    await store.complete(actionId,{resourceId:r.id,removed:r.provider==='vercel',archived:r.provider==='github'});
   }
  }
  if(r.provider==='vercel'||r.provider==='github'){
   const actionId='act_'+digest(['retirement',p.id]).slice(0,24);
   if(await store.get('action',actionId))await store.complete(actionId,{resourceId:r.id,removed:r.provider==='vercel',archived:r.provider==='github'});
  }
  r=await resource(r.id);const status=r.provider==='github'?'archived':r.status==='removed'?'removed':'retired';
  if(r.status!==status)await store.change('resource',r.id,r.revision,{...r,status,retiredAt:stamp(),revision:r.revision+1});
  return save(p,{state:'completed',status,completedAt:stamp(),historyRetained:true,holdsReleased:false,providerRuntimeStopped:r.provider==='vercel'||r.kind==='managed-network-volume',remainingCosts:'External subscriptions, retained packages, archives, account fees and already-accrued usage remain payable. This is not a final provider invoice.',proof:d});
 }
 return {async call(operation,input,requestId){
  if(operation==='retirement_inventory')return inventory(input.resourceId);
  if(operation==='retirement_read')return read(input.planId);
  if(operation==='retirement_apply')return apply(input.planId);
  if(operation!=='retirement_prepare'||!clean(requestId)||!clean(input.reason)||!Number.isSafeInteger(input.expectedRevision))fail('request_invalid');
  const id='ret_'+digest(['owner',requestId]).slice(0,24),existing=await store.get('retirement',id);
  if(existing){if(!sameValue(existing.input,input))fail('request_conflict');return existing;}
  const r=await resource(input.resourceId);if(r.revision!==input.expectedRevision||frozen.has(r.status))fail('resource_changed');
  const disposition=await proof(r,input.disposition),v=await inventory(r.id);
  return (await store.put('retirement',id,{id,input,resourceId:r.id,resourceRevision:r.revision,disposition:input.disposition,proof:disposition,reason:input.reason,inventory:v,state:'prepared',revision:1,createdAt:stamp(),updatedAt:stamp(),next:'retirement_apply with this planId quiesces these owned dependencies. Reuse the same plan until settled.'})).value;
 }};
}
