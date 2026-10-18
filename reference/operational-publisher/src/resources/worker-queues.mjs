import {digest} from './store.mjs';
import {validateEndpointSchema} from './endpoints.mjs';
const fail=c=>{throw Error('resource_worker_'+c);};
const ordered=v=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
const fingerprint=v=>digest(ordered(v));
const active=s=>['ready','working','waiting'].includes(s);
const terminal=s=>['succeeded','failed','cancelled'].includes(s);
const finite=(n,a,b)=>Number.isSafeInteger(n)&&n>=a&&n<=b;
const clean=(s,n)=>typeof s==='string'&&s.trim().length>0&&s.length<=n;
export const workerInputs={worker_queue_create:['name','purpose','workId','inputSchema','concurrency'],worker_claim:['resourceId','workerId','leaseSeconds'],worker_renew:['resourceId','jobId','claimId','leaseSeconds'],worker_checkpoint:['resourceId','jobId','claimId','expectedCheckpoint','data'],worker_finish:['resourceId','jobId','claimId','state','output'],worker_result:['resourceId','jobId','offset'],worker_resume:['resourceId','jobId','expectedRevision','checkpointRevision','originalClaimId','effectsReconciled','reason']};
export function managedWorkerQueues({store,seal,open,workStatus,now=Date.now}){
 const stamp=()=>new Date(now()).toISOString(),key=(q,j)=>q+':'+j;
 async function queue(id){const q=await store.get('queue',id);if(q?.delivery!=='pull')fail('queue_invalid');return q;}
 async function job(q,id){if(!/^job_[a-f0-9]{24}$/.test(id??''))fail('job_invalid');const j=await store.get('job',key(q.id,id));if(!j)fail('job_missing');return j;}
 async function allowed(q,delegation){
  const r=await store.get('resource',q.id);if(!r||!q.enabled||q.retirementPlanId||r.retirementPlanId||['removed','retired'].includes(r.status)||!active(await workStatus(q.workId)))fail('queue_inactive');
  if(delegation){const g=await store.get('secret',delegation.id);if(g?.kind!=='broker-grant'||g.status!=='active'||g.version!==delegation.version||g.rules?.workId!==q.workId||!g.rules.resourceIds?.includes(q.id)||!g.expiresAt||Date.parse(g.expiresAt)<=now())fail('grant_inactive');return Date.parse(g.expiresAt);}
  return Number.POSITIVE_INFINITY;
 }
 async function change(q,j,changes){const n={...j,...changes,revision:j.revision+1,updatedAt:stamp()};await store.change('job',key(q.id,j.id),j.revision,n);await store.put('job-history',key(q.id,j.id)+':'+n.revision,publicJob(n));return n;}
 function publicJob(j){const {argumentsSealed,...v}=j;return v;}
 async function release(qid,claimId){for(let i=0;i<5;i++){const q=await queue(qid);if(!(q.slots??[]).some(s=>s.token===claimId))return;try{await store.change('queue',qid,q.revision,{...q,slots:q.slots.filter(s=>s.token!==claimId),revision:q.revision+1});return;}catch(e){if(e.message!=='resource_revision_conflict')throw e;}}fail('slot_conflict');}
 async function slot(qid,claimId,jobId,until){for(let i=0;i<5;i++){const q=await queue(qid);if(!q.enabled||q.retirementPlanId)fail('queue_inactive');const slots=(q.slots??[]).filter(s=>s.until>now()&&s.token!==claimId);if(slots.length>=q.concurrency)return false;try{await store.change('queue',qid,q.revision,{...q,slots:[...slots,{token:claimId,jobId,until}],revision:q.revision+1});return true;}catch(e){if(e.message!=='resource_revision_conflict')throw e;}}fail('slot_conflict');}
 async function checkpoint(q,j){if(!j.checkpoint)return null;const c=await store.get('worker-checkpoint',j.checkpoint.id);if(!c||c.jobId!==j.id||c.resourceId!==q.id||c.digest!==j.checkpoint.digest)fail('checkpoint_missing');return {...j.checkpoint,data:JSON.parse(open(c.sealed,c.id))};}
 async function delivery(q,j,claim){return {state:'claimed',resourceId:q.id,jobId:j.id,claimId:claim.id,workerId:claim.workerId,leaseUntil:j.leaseUntil,revision:j.revision,arguments:JSON.parse(open(j.argumentsSealed,key(q.id,j.id))),checkpoint:await checkpoint(q,j),stableEffectPrefix:j.originalRequestId,externalEffects:'Use original stable effect IDs and reconcile every unknown result. Lease expiry never automatically replays this job.'};}
 function current(j,claimId,principal){if(j.state!=='running'||j.worker?.claimId!==claimId||j.worker?.principal!==principal||j.leaseUntil<=now())fail('lease_lost');}
 async function intent(kind,id,input,value){const old=await store.get(kind,id);if(old){if(old.inputDigest!==fingerprint(input))fail('request_conflict');return old;}const saved=(await store.put(kind,id,{...value,inputDigest:fingerprint(input),createdAt:stamp()})).value;if(saved.inputDigest!==fingerprint(input))fail('request_conflict');return saved;}
 async function call(operation,input,requestId,delegation=null){
  if(!clean(requestId,200))fail('request_invalid');const principal=delegation?.id??'owner',id='wq_'+digest([principal,requestId]).slice(0,24);
  if(operation==='worker_queue_create'){
   if(delegation)fail('owner_required');if(!/^[a-z][a-z0-9-]{1,40}$/.test(input.name??'')||!clean(input.purpose,350)||!/^nw_[a-z0-9_-]{1,80}$/.test(input.workId??'')||!active(await workStatus(input.workId))||!finite(input.concurrency??1,1,100))fail('definition_invalid');
   validateEndpointSchema(input.inputSchema);if(input.inputSchema.type!=='object')fail('schema_invalid');
   const resourceId='res_'+digest(['worker-queue',requestId]).slice(0,24),q={id:resourceId,name:input.name,purpose:input.purpose,workId:input.workId,inputSchema:input.inputSchema,concurrency:input.concurrency??1,enabled:true,slots:[],revision:1,provider:'internal',kind:'managed-queue',owner:'Claus',providerId:resourceId,delivery:'pull',endpointId:null,endpointRevision:null,createdAt:stamp(),inputHash:fingerprint(input)};
   const saved=(await store.put('queue',resourceId,q)).value;if(saved.inputHash!==q.inputHash)fail('request_conflict');await store.put('resource',resourceId,saved);return {resource:saved};
  }
  const q=await queue(input.resourceId);
  if(operation==='worker_result'){
   const j=await job(q,input.jobId);if(!j.finishedBy)return {job:publicJob(j),resultAvailable:false};
   const r=await store.get('worker-finish',j.finishedBy);if(!r||delegation&&r.principal!==principal)fail('result_unavailable');
   const text=open(r.sealed,j.finishedBy),offset=input.offset??0;if(!finite(offset,0,text.length))fail('result_offset');const end=Math.min(text.length,offset+24000);
   return {job:publicJob(j),resultAvailable:true,text:text.slice(offset,end),offset,nextOffset:end<text.length?end:null,totalChars:text.length,sha256:r.digest,instructionAuthority:false};
  }
  const expires=await allowed(q,delegation);
  if(operation==='worker_claim'){
   if(!clean(input.workerId,100)||!finite(input.leaseSeconds,30,900))fail('claim_invalid');
   let claim=await store.get('worker-claim',id);if(claim&&claim.inputDigest!==fingerprint(input))fail('request_conflict');
   if(claim?.state==='empty')return {state:'empty',retryAfterSeconds:30,originalRequestId:requestId};
   if(!claim){
    const page=await store.jobs(q.id,['queued','waiting'],0,true);let selected;
    for(const j of page.items){let ready=true;for(const dep of j.dependencies??[]){if((await job(q,dep)).state!=='succeeded'){ready=false;break;}}if(ready){selected=j;break;}}
    const until=Math.min(now()+input.leaseSeconds*1000,expires);if(until<=now()+5000)fail('grant_expiring');
    claim=await intent('worker-claim',id,input,{id,resourceId:q.id,principal,workerId:input.workerId,jobId:selected?.id??null,jobRevision:selected?.revision??null,until,state:selected?'selected':'empty'});
   }
   if(!claim.jobId)return {state:'empty',retryAfterSeconds:30,originalRequestId:requestId};
   let j=await job(q,claim.jobId);
   if(j.worker?.claimId===id){if(j.leaseUntil<=now()||j.state!=='running')return {state:'original_claim_closed',job:publicJob(j),retry:false};return delivery(q,j,claim);}
   if(j.revision!==claim.jobRevision||!['queued','waiting'].includes(j.state)||claim.until<=now())return {state:'claim_superseded',jobId:j.id,retry:false};
   if(!await slot(q.id,id,j.id,claim.until))return {state:'capacity_wait',retryAfterSeconds:30,originalRequestId:requestId};
   try{await allowed(await queue(q.id),delegation);j=await change(q,j,{state:'running',leaseUntil:claim.until,attempt:(j.attempt??0)+1,worker:{claimId:id,principal,workerId:claim.workerId,epoch:(j.attempt??0)+1},reason:null});}
   catch(e){const latest=await job(q,j.id);if(latest.worker?.claimId===id&&latest.state==='running'&&latest.leaseUntil>now())return delivery(q,latest,claim);await release(q.id,id);if(e.message==='resource_revision_conflict')return {state:'claim_superseded',jobId:j.id,retry:false};throw e;}
   return delivery(q,j,claim);
  }
  let j=await job(q,input.jobId);
  if(operation==='worker_resume'){
   if(delegation)fail('owner_required');const original=await store.get('worker-resume',id);if(original){if(original.inputDigest!==fingerprint(input))fail('request_conflict');if(j.lastResume===id)return {job:publicJob(j),checkpoint:j.checkpoint};}
   if(j.revision!==input.expectedRevision||j.worker?.claimId!==input.originalClaimId||j.leaseUntil>now()||terminal(j.state)||!j.checkpoint||j.checkpoint.revision!==input.checkpointRevision||input.effectsReconciled!==true||!clean(input.reason,2000))fail('resume_not_proven');
   await checkpoint(q,j);await intent('worker-resume',id,input,{resourceId:q.id,jobId:j.id,priorClaim:j.worker,checkpoint:j.checkpoint,operatorAssessment:true});
   j=await change(q,j,{state:'queued',worker:null,leaseUntil:null,lastResume:id,nextAt:stamp(),reason:'owner_reconciled_checkpoint_resume'});await release(q.id,input.originalClaimId);return {job:publicJob(j),checkpoint:j.checkpoint,automaticReplay:false};
  }
  if(operation==='worker_finish'&&j.finishedBy===id){const receipt=await store.get('worker-finish',id);if(!receipt||receipt.inputDigest!==fingerprint(input)||receipt.principal!==principal)fail('request_conflict');await release(q.id,input.claimId);return {job:publicJob(j),output:JSON.parse(open(receipt.sealed,id))};}
  current(j,input.claimId,principal);
  if(operation==='worker_renew'){
   if(!finite(input.leaseSeconds,30,900))fail('lease_invalid');const r=await intent('worker-renew',id,input,{resourceId:q.id,jobId:j.id,principal,until:Math.min(now()+input.leaseSeconds*1000,expires)});
   if(j.leaseUntil>=r.until)return {job:publicJob(j)};
   if(r.until<=now()+5000||!await slot(q.id,input.claimId,j.id,r.until))fail('lease_unavailable');
   await allowed(await queue(q.id),delegation);current(await job(q,j.id),input.claimId,principal);j=await change(q,j,{leaseUntil:r.until});return {job:publicJob(j)};
  }
  if(operation==='worker_checkpoint'){
   if(!finite(input.expectedCheckpoint,0,10000000))fail('checkpoint_revision_invalid');const raw=JSON.stringify(input.data);if(raw===undefined||Buffer.byteLength(raw)>1000000)fail('checkpoint_size');
   const previous=await store.get('worker-checkpoint',id);if(previous&&previous.inputDigest!==fingerprint(input))fail('request_conflict');
   let ancestor=j.checkpoint?.id;for(let depth=0;ancestor&&depth<1000;depth++){if(ancestor===id)return {job:publicJob(j),checkpointAccepted:true};const c=await store.get('worker-checkpoint',ancestor);ancestor=c?.parent??null;}
   if((j.checkpoint?.revision??0)!==input.expectedCheckpoint)fail('checkpoint_revision_conflict');
   const c=await intent('worker-checkpoint',id,input,{id,resourceId:q.id,jobId:j.id,principal,claimId:input.claimId,parent:j.checkpoint?.id??null,revision:input.expectedCheckpoint+1,digest:digest(raw),sealed:seal(raw,id)});
   await allowed(await queue(q.id),delegation);current(await job(q,j.id),input.claimId,principal);j=await change(q,j,{checkpoint:{id,revision:c.revision,digest:c.digest,at:c.createdAt}});return {job:publicJob(j)};
  }
  if(operation==='worker_finish'){
   if(!['succeeded','failed'].includes(input.state))fail('finish_state_invalid');const raw=JSON.stringify(input.output);if(raw===undefined||Buffer.byteLength(raw)>1000000)fail('result_size');
   const receipt=await intent('worker-finish',id,input,{resourceId:q.id,jobId:j.id,principal,claimId:input.claimId,digest:digest(raw),sealed:seal(raw,id)});
   await allowed(await queue(q.id),delegation);current(await job(q,j.id),input.claimId,principal);
   j=await change(q,j,{state:input.state,leaseUntil:null,finishedBy:id,receipt:{workerResultId:id,responseSha256:receipt.digest,observedAt:receipt.createdAt},reason:input.state==='failed'?'worker_reported_failure':null});await release(q.id,input.claimId);return {job:publicJob(j),output:JSON.parse(open(receipt.sealed,id))};
  }
  fail('operation_invalid');
 }
 return {call};
}
