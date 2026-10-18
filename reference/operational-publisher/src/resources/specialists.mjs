import {digest,sameValue} from './store.mjs';
import {endpointArguments} from './endpoints.mjs';
const fail=c=>{throw Error('resource_specialist_'+c);};
const active=s=>['ready','working','waiting'].includes(s);
const name=s=>typeof s==='string'&&/^[a-z][a-z0-9-]{1,80}$/.test(s);
const clean=(s,n=2000)=>typeof s==='string'&&s.trim().length>0&&s.length<=n&&!/-----BEGIN|Bearer\s|(?:password|token|secret|api[-_]?key)\s*[=:]\s*\S{8}/i.test(s);
const closed=s=>['accepted','failed','stopped'].includes(s);
export const specialistInputs={specialists:['offset'],specialist_define:['name','expectedRevision','role','workId','workerResourceId','queueId','grantId','statusEndpointId','stopEndpointId'],specialist_start:['name','revision','task','acceptance','context'],specialist_read:['assignmentId'],specialist_poll:['assignmentId'],specialist_stop:['assignmentId','reason'],specialist_accept:['assignmentId','responseId','assessment','assets']};
export function managedSpecialists({store,providers,invoke,open,workStatus,now=Date.now}){
 const stamp=()=>new Date(now()).toISOString();
 async function profile(id){if(!name(id))fail('name_invalid');const p=await store.get('specialist',id);if(!p)fail('not_found');return p;}
 async function assignment(id){if(!/^asg_[a-f0-9]{24}$/.test(id??''))fail('assignment_invalid');const a=await store.get('assignment',id);if(!a)fail('assignment_missing');return a;}
 async function endpoint(id){const e=await store.get('resource',id);if(e?.provider!=='http'||e.status!=='active'||e.retirementPlanId)fail('endpoint_unavailable');return e;}
 async function eligible(p){
  if(!active(await workStatus(p.workId)))fail('work_inactive');
  const w=await store.get('resource',p.workerResourceId),g=await store.get('secret',p.grantId),q=await store.get('queue',p.queueId);
  if(!w||w.protected||w.provider!=='vercel'||w.retirementPlanId||w.status==='removed')fail('worker_unavailable');
  if(!g||g.kind!=='broker-grant'||g.status!=='active'||g.rules.workId!==p.workId||!g.expiresAt||Date.parse(g.expiresAt)<=now())fail('grant_unavailable');
  if(!q||!q.enabled||q.workId!==p.workId||q.retirementPlanId)fail('queue_unavailable');
  const binding=await store.get('binding',w.id+':CLAUS_BROKER_GRANT');
  if(binding?.secretId!==g.id||binding.version!==g.version)fail('worker_grant_binding_required');
  const e=await endpoint(q.endpointId);if(e.revision!==q.endpointRevision)fail('queue_endpoint_changed');
  // The original managed publication must postdate the binding. This proves
  // an owner deployment after binding, not correctness of arbitrary worker code.
  const publications=[];let offset=0;do{const page=await store.list('publication',offset);publications.push(...page.items);offset=page.nextOffset;}while(offset!==null);
  const production=await providers.read(w);
  if(!production||production.providerId!==w.providerId||!publications.some(x=>x.resourceId===w.id&&x.deployment?.id===production.deployment&&Date.parse(x.at)>=Date.parse(binding.updatedAt)))fail('worker_deployment_after_binding_required');
  return {w,g,q,e};
 }
 async function change(a,patch){return store.change('assignment',a.id,a.revision,{...a,...patch,revision:a.revision+1,updatedAt:stamp()});}
 async function response(a,responseId){
  const link=await store.get('specialist-response',a.id+':'+responseId),r=await store.get('endpoint-response',responseId);
  if(!link||!r||r.status<200||r.status>=300||r.status===202)fail('complete_response_required');
  let body;try{body=JSON.parse(open(r.sealed,responseId));}catch{fail('response_contract_invalid');}
  if(!body||typeof body!=='object'||body.assignmentId!==a.id||body.workId!==a.profile.workId||!['succeeded','failed','stopped'].includes(body.state))fail('response_contract_invalid');
  if(body.state==='succeeded'&&(body.output===undefined||body.output===null||body.output===''))fail('output_required');
  return {responseId,sha256:r.digest,observedAt:r.at,body,instructionAuthority:false};
 }
 async function link(a,id){if(id&&await store.get('endpoint-response',id))await store.put('specialist-response',a.id+':'+id,{assignmentId:a.id,responseId:id,at:stamp()});}
 async function read(a){
  const job=a.jobId&&await store.get('job',a.profile.queueId+':'+a.jobId);
  if(job?.receipt?.actionId)await link(a,job.receipt.actionId);
  const latest=a.lastResponseId??job?.receipt?.actionId;let completion=null;
  if(latest)try{const proof=await response(a,latest);completion={responseId:proof.responseId,sha256:proof.sha256,workerState:proof.body.state};if(['queued','prepared','delivered'].includes(a.state)&&['succeeded','failed'].includes(proof.body.state)){const state=proof.body.state==='succeeded'?'delivered':'failed';if(a.state!==state)a=await change(a,{state});}}catch(error){if(!/^resource_specialist_(complete_response_required|response_contract_invalid|output_required)$/.test(error.message))throw error;}
  return {...a,completion,queueState:job?.state??null,originalResponseId:job?.receipt?.actionId??null,grantBudget:await store.grantBudget(a.profile.grantId),meaning:'An assignment and delivery receipt are not proof of autonomous intelligence or external user acceptance. Use specialist_accept only after inspecting the matching complete response and actual artifacts.'};
 }
 async function step(a,suffix,operation,input){const key=a.id+':'+suffix,stored=(await store.put('specialist-step',key,{operation,input,requestId:key})).value;if(stored.operation!==operation)fail('step_conflict');return invoke(stored.operation,stored.input,stored.requestId);}
 return {async call(operation,input,requestId){
  if(operation==='specialists'){if(!Number.isSafeInteger(input.offset??0)||(input.offset??0)<0)fail('offset_invalid');return store.list('specialist',input.offset??0);}
  if(operation==='specialist_read')return read(await assignment(input.assignmentId));
  if(!clean(requestId,200))fail('request_invalid');
  if(operation==='specialist_define'){
   if(!name(input.name)||!clean(input.role,160)||!/^nw_[a-z0-9_-]{1,80}$/.test(input.workId??'')||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)fail('definition_invalid');
   const p=await store.get('specialist',input.name);if(p?.lastRequestId===requestId){if(!sameValue(p.input,input))fail('request_conflict');return p;}
   if((p?.revision??0)!==input.expectedRevision)fail('revision_conflict');
   const v={...input,input,lastRequestId:requestId,revision:input.expectedRevision+1,updatedAt:stamp()};await eligible(v);
   const stop=await endpoint(v.stopEndpointId);endpointArguments(stop.definition.inputSchema,{assignmentId:'asg_'+'0'.repeat(24),workId:v.workId,reason:'owner_stop'});
   if(v.statusEndpointId){const status=await endpoint(v.statusEndpointId);endpointArguments(status.definition.inputSchema,{assignmentId:'asg_'+'0'.repeat(24),workId:v.workId});}
   if(p)await store.change('specialist',v.name,p.revision,v);else{const saved=await store.put('specialist',v.name,v);if(saved.value.lastRequestId!==requestId)fail('revision_conflict');}
   await store.put('specialist-version',v.name+':'+v.revision,v);return v;
  }
  if(operation==='specialist_start'){
   const id='asg_'+digest(['owner',requestId]).slice(0,24),old=await store.get('assignment',id);
   if(old&&!sameValue(old.input,input))fail('request_conflict');
   let a=old;
   if(!a){
    const p=await profile(input.name),{g,e}=await eligible(p);
    if(p.revision!==input.revision||!clean(input.task,6000)||!clean(input.acceptance,3000))fail('task_invalid');
    const payload={assignmentId:id,workId:p.workId,role:p.role,task:input.task,acceptance:input.acceptance,deadline:g.expiresAt,context:input.context??null};endpointArguments(e.definition.inputSchema,payload);
    // One slot per worker prevents two assignments sharing/revoking one grant.
    for(const slotId of [p.workerResourceId,p.grantId]){
    const slot=await store.get('specialist-slot',slotId);
    if(slot&&slot.assignmentId!==id){const previous=await assignment(slot.assignmentId);if(!closed(previous.state))fail('worker_busy');}
    const next={assignmentId:id,revision:(slot?.revision??0)+1};if(slot)await store.change('specialist-slot',slotId,slot.revision,next);else if((await store.put('specialist-slot',slotId,next)).value.assignmentId!==id)fail('worker_busy');
    }
    a=(await store.put('assignment',id,{id,input,profile:p,payload,state:'prepared',revision:1,createdAt:stamp(),updatedAt:stamp(),deadline:g.expiresAt,grantVersion:g.version,maximumSpendMicroUsd:g.rules.maximumSpendMicroUsd??'0',repositoryScopes:g.rules.repositoryScopes??[]})).value;
   }
   if(!a.jobId){await eligible(a.profile);const j=await step(a,'enqueue','queue_enqueue',{resourceId:a.profile.queueId,arguments:a.payload});a=await change(a,{jobId:j.id,state:'queued'});}
   await step(a,'run','queue_run',{resourceId:a.profile.queueId,jobId:a.jobId});return read(a);
  }
  let a=await assignment(input.assignmentId);
  if(operation==='specialist_poll'){
   if(!a.profile.statusEndpointId)fail('status_endpoint_missing');const e=await endpoint(a.profile.statusEndpointId);
   const r=await invoke('endpoint_invoke',{resourceId:e.id,revision:e.revision,arguments:{assignmentId:a.id,workId:a.profile.workId}},requestId);await link(a,r.actionId??r.id);if(await store.get('specialist-response',a.id+':'+(r.actionId??r.id)))a=await change(a,{lastResponseId:r.actionId??r.id});return {assignment:await read(a),observation:r,instructionAuthority:false};
  }
  if(operation==='specialist_stop'){
   if(!clean(input.reason))fail('reason_invalid');
   if(a.state==='accepted'||a.state==='stopped')return read(a);
   if(a.stopReason&&a.stopReason!==input.reason)fail('stop_request_conflict');
   if(!a.stopReason)a=await change(a,{state:'stopping',stopReason:input.reason});
   const g=await store.get('secret',a.profile.grantId);if(g?.status==='active')await step(a,'revoke','secret_revoke',{secretId:g.id,expectedRevision:g.revision});
   const job=a.jobId&&await store.get('job',a.profile.queueId+':'+a.jobId);
   if(job&&!['succeeded','failed','accepted','cancelled'].includes(job.state))try{await step(a,'cancel','queue_cancel',{resourceId:a.profile.queueId,jobId:job.id,expectedRevision:job.revision});}catch(error){if(!/original_response_must_be_reconciled|revision_conflict/.test(error.message))throw error;}
   const e=await endpoint(a.profile.stopEndpointId),r=await step(a,'stop','endpoint_invoke',{resourceId:e.id,revision:e.revision,arguments:{assignmentId:a.id,workId:a.profile.workId,reason:input.reason}});await link(a,r.actionId??r.id);
   let proof;try{proof=await response(a,r.actionId??r.id);}catch{}
   if(proof?.body.state==='stopped')a=await change(a,{state:'stopped',stopResponseId:proof.responseId});
   return {...await read(a),newBrokerCallsRevoked:true,stopAcknowledged:!!proof&&proof.body.state==='stopped',providerComputeDeleted:false};
  }
  if(operation==='specialist_accept'){
   if(!clean(input.assessment,4000)||!Array.isArray(input.assets)||input.assets.length>50)fail('acceptance_invalid');
   const proof=await response(a,input.responseId);if(proof.body.state!=='succeeded')fail('successful_response_required');
   for(const ref of input.assets){const asset=await store.get('asset-version',ref.name+':'+ref.version),publication=await store.get('asset-publication',ref.name+':'+ref.version);if(!asset||!publication||asset.workId!==a.profile.workId)fail('matching_artifact_required');}
   if(a.state==='accepted'){if(!sameValue(a.acceptanceInput,input))fail('acceptance_conflict');return read(a);}
   a=await change(a,{state:'accepted',acceptanceInput:input,responseProof:{responseId:proof.responseId,sha256:proof.sha256},acceptedAt:stamp(),acceptedBy:'Claus owner workflow',externalUserAcceptance:false});return read(a);
  }
  fail('operation_invalid');
 },async tick(){
  const cursor=await store.get('specialist-cursor','main'),offset=cursor?.offset??0,page=await store.list('assignment',offset);let advance=page.nextOffset??0,result=null;
  for(let i=0;i<page.items.length;i++){
   const a=page.items[i];if(closed(a.state))continue;
   const g=await store.get('secret',a.profile.grantId),inactive=!active(await workStatus(a.profile.workId))||Date.parse(a.deadline)<=now()||g?.status!=='active'||g.version!==a.grantVersion;
   if(!inactive&&a.state!=='stopping')continue;
   try{const stopped=await this.call('specialist_stop',{assignmentId:a.id,reason:a.stopReason??'work_or_grant_inactive'},'automatic-stop:'+a.id);result={assignmentId:a.id,state:stopped.state};}catch(e){result={assignmentId:a.id,state:'stop_pending',reason:/^resource_[a-z_]+$/.test(e.message)?e.message:'resource_specialist_stop_unavailable'};}
   advance=offset+i+1;break;
  }
  const value={offset:advance,revision:(cursor?.revision??0)+1};if(cursor)await store.change('specialist-cursor','main',cursor.revision,value);else await store.put('specialist-cursor','main',value);
  return {processed:result?1:0,result};
 }};
}
