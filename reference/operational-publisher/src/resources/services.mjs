import {digest} from './store.mjs';
import {validateSettings} from './providers.mjs';
import {randomUUID} from 'node:crypto';
const fail=c=>{throw Error('resource_service_'+c);};
const active=s=>['ready','working','waiting'].includes(s);
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).every(k=>keys.includes(k));
const text=(v,n)=>typeof v==='string'&&v.trim().length>0&&v.length<=n&&!/-----BEGIN|Bearer\s|(?:password|token|secret|api[-_]?key)\s*[=:]\s*\S{8}/i.test(v);
const canonical=v=>Array.isArray(v)?v.map(canonical):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const same=(a,b)=>digest(canonical(a))===digest(canonical(b));
export const serviceInputs={services:['offset'],service_read:['name','revision'],service_define:['name','expectedRevision','purpose','workId','targets','enabled'],service_status:['name'],service_plan:['name','revision'],service_apply:['planId']};

// A service definition is desired configuration for resources already delegated
// to Claus. It cannot edit core policy, create authority, or silently adopt an
// untracked resource. Plans retain exact observations and original action IDs.
export function managedServices({store,providers,open,workStatus,invoke,now=Date.now}){
 const stamp=()=>new Date(now()).toISOString();
 async function resource(id){if(!/^res_[a-f0-9]{24}$/.test(id??''))fail('reference_invalid');const r=await store.get('resource',id);if(!r||r.protected)fail('resource_unavailable');return r;}
 async function head(name){if(!/^[a-z][a-z0-9-]{1,80}$/.test(name??''))fail('name_invalid');const v=await store.get('service',name);if(!v)fail('not_found');return v;}
 async function secret(b,requireActive=true){
  if(!exact(b,['envName','secretId','version'])||! /^[A-Z][A-Z0-9_]{1,100}$/.test(b.envName??'')||/^(NEXT_PUBLIC_|PUBLIC_|VITE_|VERCEL_|NODE_)/.test(b.envName)||!/^sec_[a-f0-9]{24}$/.test(b.secretId??'')||!Number.isSafeInteger(b.version)||b.version<1)fail('binding_invalid');
  const s=await store.get('secret',b.secretId);if(!s||!['application','external-service','database-connection','broker-grant'].includes(s.kind)||requireActive&&(s.status!=='active'||s.version!==b.version||s.expiresAt&&Date.parse(s.expiresAt)<=now()||s.kind==='broker-grant'&&!active(await workStatus(s.rules?.workId))))fail('secret_inactive');return s;
 }
 async function definition(input){
  if(!/^[a-z][a-z0-9-]{1,80}$/.test(input.name??'')||!text(input.purpose,1200)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||typeof input.enabled!=='boolean'||!/^nw_[a-z0-9_-]{1,80}$/.test(input.workId??'')||!await workStatus(input.workId)||input.enabled&&!active(await workStatus(input.workId)))fail('definition_invalid');
  if(!Array.isArray(input.targets)||!input.targets.length||input.targets.length>50||new Set(input.targets.map(t=>t.resourceId)).size!==input.targets.length)fail('targets_invalid');
  const seen=new Set();
  for(const t of input.targets){
   if(!exact(t,['resourceId','dependsOn','settings','bindings','queue','deployment'])||!Array.isArray(t.dependsOn)||t.dependsOn.some(id=>!seen.has(id)))fail('dependency_order_invalid');
   const r=await resource(t.resourceId);seen.add(r.id);
   if(t.settings!==undefined){if(r.provider!=='vercel')fail('settings_scope');validateSettings(t.settings);if(Object.values(t.settings).some(v=>v!==null&&!text(v,2000)))fail('settings_invalid');}
   if(t.bindings!==undefined){if(r.provider!=='vercel'||!Array.isArray(t.bindings)||t.bindings.length>32||new Set(t.bindings.map(b=>b.envName)).size!==t.bindings.length)fail('bindings_invalid');for(const b of t.bindings)await secret(b,input.enabled);}
   if(t.queue!==undefined&&(!exact(t.queue,['enabled','concurrency'])||r.kind!=='managed-queue'||typeof t.queue.enabled!=='boolean'||!Number.isSafeInteger(t.queue.concurrency)||t.queue.concurrency<1||t.queue.concurrency>100))fail('queue_invalid');
   if(t.deployment!==undefined){const d=t.deployment;if(r.provider!=='vercel'||!exact(d,['repositoryId','commit','healthPath'])||!/^[a-f0-9]{40}$/.test(d.commit??'')||!/^\/[a-zA-Z0-9_./-]{0,150}$/.test(d.healthPath??'')||d.healthPath.startsWith('//'))fail('deployment_invalid');if((await resource(d.repositoryId)).provider!=='github')fail('repository_invalid');}
  }
 }
 async function observeTarget(t){
  const r=await resource(t.resourceId),v={resourceId:r.id,provider:r.provider,status:r.status??'active'};
  if(t.settings)v.settings=await providers.readSettings(r,Object.keys(t.settings));
  if(t.bindings?.length){
   const envs=await providers.envs(r);v.bindings=[];
   for(const b of t.bindings){const s=await secret(b),found=envs.find(e=>e.key===b.envName&&e.target?.includes('production')),binding=await store.get('binding',r.id+':'+b.envName);v.bindings.push({envName:b.envName,providerId:found?.id??null,managed:!!binding,secretId:binding?.secretId??null,version:binding?.version??null,matches:!!found&&await providers.envValue(r,found.id)===open(s.sealed,s.id+':'+s.version)});}
  }
  if(t.queue){const q=await store.get('queue',r.id);if(!q)fail('queue_unavailable');v.queue={enabled:q.enabled,concurrency:q.concurrency};}
  if(t.deployment){const p=await providers.read(r);if(!p)fail('project_missing');const pub=p.deployment&&await store.get('publication',p.deployment);v.deployment={id:p.deployment,commit:pub?.sourceCommit??null,repositoryId:pub?.repositoryId??null};}
  return v;
 }
 function changes(t,v){
  const steps=[];
  if(t.settings&&!same(t.settings,v.settings))steps.push({operation:'settings',input:{resourceId:t.resourceId,settings:t.settings}});
  for(const b of t.bindings??[]){const actual=v.bindings.find(x=>x.envName===b.envName);if(!actual.matches||actual.secretId!==b.secretId||actual.version!==b.version){if(actual.providerId&&!actual.managed)fail('unmanaged_environment');steps.push({operation:'bind_secret',input:{resourceId:t.resourceId,...b}});}}
  if(t.queue&&!same(t.queue,v.queue))steps.push({operation:'queue_update',input:{resourceId:t.resourceId,...t.queue}});
  if(t.deployment&&(steps.length||v.deployment.commit!==t.deployment.commit||v.deployment.repositoryId!==t.deployment.repositoryId))steps.push({operation:'deploy',input:{resourceId:t.resourceId,...t.deployment},expectedDeploymentId:v.deployment.id});
  return steps;
 }
 async function status(service){const targets=[];for(const t of service.targets){const observation=await observeTarget(t);targets.push({resourceId:t.resourceId,observation,changes:changes(t,observation)});}return {name:service.name,revision:service.revision,enabled:service.enabled,workActive:active(await workStatus(service.workId)),targets,observedAt:stamp(),requiresExplicitApply:true};}
 async function saveExecution(e,patch){return store.change('service-execution',e.planId,e.revision,{...e,...patch,revision:e.revision+1,updatedAt:stamp()});}
 async function acquire(name){
  const old=await store.get('service-lease',name);if(old?.until>now())return null;
  const value={token:randomUUID(),until:now()+180000,revision:(old?.revision??0)+1};
  if(old){try{await store.change('service-lease',name,old.revision,value);}catch(e){if(e.message==='resource_revision_conflict')return null;throw e;}}
  else if((await store.put('service-lease',name,value)).value.token!==value.token)return null;
  return value.token;
 }
 async function release(name,token){const l=await store.get('service-lease',name);if(l?.token===token)await store.change('service-lease',name,l.revision,{...l,until:0,revision:l.revision+1});}
 async function apply(planId){
  const p=await store.get('service-plan',planId);if(!p)fail('plan_unavailable');
  const s=await head(p.name);if(!s.enabled||s.revision!==p.serviceRevision||!active(await workStatus(s.workId)))fail('definition_changed_or_inactive');
  const lease=await acquire(s.name);if(!lease)return {planId,state:'busy'};
  try{
  const saved=await store.put('service-execution',planId,{planId,revision:1,cursor:0,state:'pending',expected:p.observations,receipts:[],step:null,leaseUntil:0});let e=saved.value;
  if(e.state==='completed')return e;
  if(e.leaseUntil>now())return {planId,state:'busy',retryAt:new Date(e.leaseUntil).toISOString()};
  e=await saveExecution(e,{leaseUntil:now()+180000,state:'working'});
  try{
   if(e.cursor>=p.steps.length)return await saveExecution(e,{state:'completed',leaseUntil:0,completedAt:stamp()});
   const planned=p.steps[e.cursor],t=s.targets.find(t=>t.resourceId===planned.input.resourceId);
   if(!e.step){
    const observed=await observeTarget(t);if(!same(observed,e.expected[t.resourceId]))fail('observation_changed_replan');
    const input={...planned.input};if(planned.operation==='queue_update')input.expectedRevision=(await store.get('queue',t.resourceId)).revision;
    e=await saveExecution(e,{step:{...planned,input,requestId:'service:'+planId+':'+e.cursor,phase:'started'}});
   }
   const step=e.step;let result;
   if(step.operation==='deploy'){
    if(!step.stage){
     result=await invoke('deployment_stage',{resourceId:t.resourceId,repositoryId:step.input.repositoryId,commit:step.input.commit,expectedDeploymentId:step.expectedDeploymentId},step.requestId+':stage');
     if(result.deployment){e=await saveExecution(e,{step:{...step,stage:result,phase:'staged'}});return {planId,state:'pending',cursor:e.cursor,deploymentId:result.deployment.id,next:'Apply this same plan again to inspect readiness and promote the original deployment.'};}
     if(result.state==='rejected')fail('deployment_rejected');
     return {planId,state:'pending',cursor:e.cursor,result};
    }
    const deployments=await providers.deployments(await resource(t.resourceId)),d=deployments.find(d=>d.id===step.stage.deployment.id);
    if(!d)fail('original_deployment_not_visible');
    if(['ERROR','CANCELED'].includes(d.state))fail('deployment_failed');
    if(d.state!=='READY')return {planId,state:'pending',cursor:e.cursor,deploymentId:d.id,deploymentState:d.state};
    result=await invoke('deployment_promote',{resourceId:t.resourceId,deploymentId:d.id,expectedDeploymentId:step.expectedDeploymentId,healthPath:step.input.healthPath},step.requestId+':promote');
   }else result=await invoke(step.operation,step.input,step.requestId);
   if(result.pending||result.state==='outcome_unknown')return {planId,state:'pending',cursor:e.cursor,result};
   const observed=await observeTarget(t),cursor=e.cursor+1;
   e=await saveExecution(e,{cursor,step:null,expected:{...e.expected,[t.resourceId]:observed},receipts:[...e.receipts,{step:e.cursor,operation:step.operation,requestId:step.requestId,result,observedAt:stamp()}],state:cursor===p.steps.length?'completed':'pending',leaseUntil:0});return e;
  }catch(error){const code=/^resource_[a-z0-9_]+$/.test(error.message)?error.message:'resource_service_operation_unavailable';e=await saveExecution(e,{state:'blocked',lastError:code,leaseUntil:0});throw Error(code);}
  finally{const current=await store.get('service-execution',planId);if(current?.revision===e.revision&&current.leaseUntil)await saveExecution(current,{leaseUntil:0});}
  }finally{await release(s.name,lease);}
 }
 async function call(operation,input,requestId){
  if(operation==='services'){if(!Number.isSafeInteger(input.offset??0)||(input.offset??0)<0)fail('page_invalid');return store.list('service',input.offset??0);}
  if(operation==='service_define'){
   await definition(input);if(!text(requestId,200))fail('request_invalid');
   const prior=await store.get('service',input.name),inputHash=digest(canonical(input));if(prior?.lastRequestId===requestId){if(prior.inputHash!==inputHash)fail('request_conflict');return prior;}
   if((prior?.revision??0)!==input.expectedRevision)fail('revision_conflict');
   const value={name:input.name,purpose:input.purpose,workId:input.workId,targets:input.targets,enabled:input.enabled,revision:input.expectedRevision+1,inputHash,lastRequestId:requestId,updatedAt:stamp(),grantsPermissions:false};
   if(prior){await store.put('service-version',prior.name+':'+prior.revision,prior);await store.change('service',input.name,prior.revision,value);}else{const v=await store.put('service',input.name,value);if(v.value.inputHash!==inputHash)fail('revision_conflict');}
   await store.put('service-version',value.name+':'+value.revision,value);return value;
  }
  if(operation==='service_apply'){if(!/^sp_[a-f0-9]{32}$/.test(input.planId??''))fail('plan_invalid');return apply(input.planId);}
  const s=await head(input.name);
  if(operation==='service_read'){if(input.revision===undefined||input.revision===s.revision)return s;const v=await store.get('service-version',s.name+':'+input.revision);if(!v)fail('version_unavailable');return {...v,historical:true};}
  if(operation==='service_status')return status(s);
  if(operation==='service_plan'){
   if(input.revision!==s.revision||!s.enabled||!active(await workStatus(s.workId)))fail('definition_changed_or_inactive');
   const actual=await status(s),observations=Object.fromEntries(actual.targets.map(t=>[t.resourceId,t.observation])),steps=actual.targets.flatMap(t=>t.changes),body={name:s.name,serviceRevision:s.revision,observations,steps},id='sp_'+digest(canonical(body)).slice(0,32);
   return (await store.put('service-plan',id,{id,...body,requiresSeparateDeployment:s.targets.filter(t=>!t.deployment&&steps.some(x=>x.input.resourceId===t.resourceId&&['settings','bind_secret'].includes(x.operation))).map(t=>t.resourceId),createdAt:stamp(),meaning:'A saved configuration plan, not an execution receipt. Apply repeatedly with this planId. Existing deployment and operating budget checks remain authoritative. Settings and bindings without a deployment target require a later deployment before runtime use.'})).value;
  }
  fail('operation_invalid');
 }
 return {call};
}
