import {canonical,copy,digest,integer,requireThat,shape,text} from '../shared/index.mjs';

const profile='claus-task-review/1';
const bounded=(value,max)=>{requireThat(typeof value==='string'&&value.trim().length>0&&value.length<=max,'invalid_task_review');return value;};
const outcomes=['pass','fail','insufficient_evidence'];
const binding=task=>({taskId:task.id,appVersion:task.version,generation:task.generation,requesterId:task.authorId,workerId:task.assigneeId,inputHash:digest(task.input),outputHash:task.outputHash,policyHash:digest(task.reviewPolicy),agreementHash:task.agreement?digest(task.agreement):null});
function evidence(items){
 requireThat(Array.isArray(items)&&items.length<=8,'invalid_task_review');
 const result=items.map(item=>{shape(item,['label','content','url']);bounded(item.label,120);bounded(item.content,8000);if(item.url!==null){bounded(item.url,2048);let u;try{u=new URL(item.url);}catch{}requireThat(u&&u.protocol==='https:'&&!u.username&&!u.password,'invalid_task_review');}return {...copy(item),hash:digest({label:item.label,content:item.content,url:item.url})};});
 requireThat(Buffer.byteLength(canonical(result))<=16000,'document_too_large');return result;
}
// These artifacts guide the parties. They do not acquire the buyer's signing
// authority, stop an escrow clock or alter an existing financial agreement.
export function createTaskReviews({storage,app,participant,effect,event,countRecord,taskPayments,now}){
 async function controller(tx,principalId){
  const p=(await tx.network.read('principals',principalId))?.value;requireThat(p,'not_found');
  if(p.projectId){const project=(await tx.network.read('projects',p.projectId))?.value;requireThat(project&&!project.archivedAt&&!project.transfer,'project_unavailable');return project.ownerId;}
  return principalId;
 }
 async function distinct(tx,reviewer,parties){
  const owner=await controller(tx,reviewer);
  for(const p of parties.filter(Boolean))requireThat(p!==reviewer&&await controller(tx,p)!==owner,'task_review_conflict');
 }
 async function policy(tx,value,requesterId){
  shape(value,['reviewerId','selectionBasis','criteria']);text(value.reviewerId);bounded(value.selectionBasis,1000);
  requireThat(Array.isArray(value.criteria)&&value.criteria.length>=1&&value.criteria.length<=12,'invalid_task_review');
  const seen=new Set();for(const c of value.criteria){shape(c,['id','description']);requireThat(typeof c.id==='string'&&/^[a-z][a-z0-9_-]{0,47}$/.test(c.id)&&!seen.has(c.id),'invalid_task_review');seen.add(c.id);bounded(c.description,1000);}
  requireThat(Buffer.byteLength(canonical(value))<=12000,'document_too_large');await distinct(tx,value.reviewerId,[requesterId]);return copy(value);
 }
 async function publicTask(tx,projectId,taskId){
  const a=await app(tx,projectId,{publicOnly:true});requireThat(a.value.manifest.tasks?.visibility==='public','not_found');
  const row=await tx.read('tasks',taskId);requireThat(row&&!row.value.hidden,'not_found');return row;
 }
 async function current(tx,projectId,taskId,reviewId,allowHistorical=false){
  const row=await publicTask(tx,projectId,taskId),request=(await tx.read('task-reviews',reviewId))?.value;
  requireThat(request&&row.value.review?.id===reviewId&&request.taskId===taskId,'not_found');
  requireThat(allowHistorical||row.value.state==='submitted'&&digest(binding(row.value))===request.bindingHash,'task_review_stale');
  requireThat(now()<request.expiresAt,'task_review_expired');return {row,request};
 }
 async function paidSnapshot(task){
  if(!task.agreement)return null;
  const payment=await taskPayments.observe(task);
  requireThat(payment.onchainState===3&&Number(payment.value.reviewDue)*1000>now(),'task_payment_not_ready');
  return payment;
 }
 async function update(tx,task,review,who,type){
  const result=await tx.write('tasks',task.value.id,{...task.value,review,updatedAt:now()},task.revision);
  await event(tx,{type,collection:'tasks',id:task.value.id,actorId:who});return {...copy(result.value),revision:result.revision};
 }
 const api={
  policy,
  async checkClaim(tx,task,workerId){if(task.reviewPolicy)await distinct(tx,task.reviewPolicy.reviewerId,[task.authorId,workerId]);if(task.reviewCommission){const r=(await tx.read('task-reviews',task.reviewCommission.reviewId))?.value;requireThat(r&&r.policy.reviewerId===workerId,'task_review_conflict');}},
  async checkCommissionDelivery(tx,task){
   if(!task.reviewCommission)return;
   const report=(await tx.read('task-review-reports',task.reviewCommission.reviewId))?.value;
   requireThat(report&&report.reviewerId===task.assigneeId&&report.requestHash===task.reviewCommission.requestHash,'task_review_not_submitted');
  },
  async request(actor,projectId,{taskId,expectedRevision,expiresAt,evidence:items,idempotencyKey}){
   return storage.transaction(projectId,async tx=>{const {who}=await participant(tx,projectId,actor);
    return effect(tx,projectId,actor,'task.review.request',idempotencyKey,{taskId,expectedRevision,expiresAt,evidence:items},async()=>{
     const row=await publicTask(tx,projectId,taskId),task=row.value;
     requireThat(row.revision===expectedRevision,'revision_conflict');requireThat(who===task.authorId,'scope_denied');
     requireThat(task.state==='submitted'&&task.reviewPolicy&&!task.review&&!task.reviewCommission,'task_review_unavailable');
     await distinct(tx,task.reviewPolicy.reviewerId,[task.authorId,task.assigneeId]);integer(expiresAt,now()+1,now()+7*86400000);
     const payment=await paidSnapshot(task);if(payment)requireThat(expiresAt<=Number(payment.value.reviewDue)*1000,'task_review_deadline');
     const attached=evidence(items),bound=binding(task),value={profile,projectId,taskId,taskRevision:row.revision,binding:bound,bindingHash:digest(bound),policy:copy(task.reviewPolicy),input:copy(task.input),output:copy(task.output),evidence:attached,evidenceHash:digest(attached),payment,requestedAt:now(),expiresAt,authority:'advisory_only'};
     const reviewId=digest(value);await countRecord(tx);await tx.write('task-reviews',reviewId,{...value,id:reviewId},0);
     const result=await update(tx,row,{id:reviewId,state:'pending'},who,'task.review.requested');return {task:result,request:{...value,id:reviewId}};
    });});
  },
  async commission(actor,projectId,{taskId,reviewId,commissionTaskId,expectedRevision,idempotencyKey}){
   return storage.transaction(projectId,async tx=>{const {who}=await participant(tx,projectId,actor);
    return effect(tx,projectId,actor,'task.review.commission',idempotencyKey,{taskId,reviewId,commissionTaskId,expectedRevision},async()=>{
     const {row,request}=await current(tx,projectId,taskId,reviewId);requireThat(who===row.value.authorId,'scope_denied');
     requireThat(!await tx.read('task-review-reports',reviewId)&&!await tx.read('task-review-commissions',reviewId),'task_review_unavailable');
     const commission=await publicTask(tx,projectId,commissionTaskId),c=commission.value;
     requireThat(commission.revision===expectedRevision,'revision_conflict');
     requireThat(c.id!==taskId&&c.authorId===who&&c.assigneeId===request.policy.reviewerId&&c.state==='claimed'&&c.leaseUntil>now()&&!c.agreement&&!c.reviewPolicy&&!c.reviewCommission,'task_review_commission_invalid');
     const link={profile,projectId,taskId,reviewId,requestHash:reviewId,commissionTaskId,reviewExpiresAt:request.expiresAt,linkedAt:now(),compensation:'separate_agreement_for_review_not_verdict'};
     await countRecord(tx);await tx.write('task-review-commissions',reviewId,link,0);
     const result=await tx.write('tasks',c.id,{...c,reviewCommission:link,updatedAt:now()},commission.revision);
     await event(tx,{type:'task.review.commissioned',collection:'tasks',id:c.id,actorId:who});return {...copy(result.value),revision:result.revision};
    });});
  },
  async submit(actor,projectId,{taskId,reviewId,report,idempotencyKey}){
   return storage.transaction(projectId,async tx=>{const {who}=await participant(tx,projectId,actor);
    return effect(tx,projectId,actor,'task.review.submit',idempotencyKey,{taskId,reviewId,report},async()=>{
     const link=(await tx.read('task-review-commissions',reviewId))?.value;
     const {row,request}=await current(tx,projectId,taskId,reviewId,!!link);
     requireThat(who===request.policy.reviewerId,'scope_denied');await distinct(tx,who,[row.value.authorId,row.value.assigneeId]);
     requireThat(!await tx.read('task-review-reports',reviewId),'task_review_already_submitted');
     const payment=link?(row.value.agreement?await taskPayments.observe(row.value):null):await paidSnapshot(row.value);let fee=null;
     if(link){const c=await publicTask(tx,projectId,link.commissionTaskId);requireThat(c.value.agreement&&c.value.state==='claimed'&&c.value.reviewCommission?.requestHash===reviewId,'task_review_commission_unfunded');fee=await taskPayments.observe(c.value);requireThat(fee.onchainState===2&&Number(fee.observedBlockTime)<=c.value.agreement.deliveryDue,'task_review_commission_unfunded');}
     shape(report,['criteria','evidence','conflicts','limitations']);bounded(report.conflicts,2000);bounded(report.limitations,2000);
     const attached=evidence(report.evidence),hashes=new Set([request.binding.inputHash,request.binding.outputHash,...request.evidence.map(e=>e.hash),...attached.map(e=>e.hash)]);
     requireThat(Array.isArray(report.criteria)&&report.criteria.length===request.policy.criteria.length,'invalid_task_review');
     const seen=new Set();for(const c of report.criteria){shape(c,['id','outcome','rationale','evidenceHashes']);requireThat(request.policy.criteria.some(p=>p.id===c.id)&&!seen.has(c.id)&&outcomes.includes(c.outcome),'invalid_task_review');seen.add(c.id);bounded(c.rationale,2000);requireThat(Array.isArray(c.evidenceHashes)&&c.evidenceHashes.length<=16&&c.evidenceHashes.every(h=>hashes.has(h))&&(c.outcome==='insufficient_evidence'||c.evidenceHashes.length>0),'task_review_evidence_missing');}
     requireThat(Buffer.byteLength(canonical(report))<=32000,'document_too_large');
     const outcome=report.criteria.some(c=>c.outcome==='fail')?'fail':report.criteria.some(c=>c.outcome==='insufficient_evidence')?'insufficient_evidence':'pass';
     const value={profile,projectId,taskId,reviewId,requestHash:reviewId,bindingHash:request.bindingHash,reviewerId:who,reviewerControllerId:await controller(tx,who),sourceCurrent:row.value.state==='submitted'&&digest(binding(row.value))===request.bindingHash&&(!payment||payment.onchainState===3),payment,criteria:copy(report.criteria),evidence:attached,evidenceHash:digest(attached),conflicts:report.conflicts,limitations:report.limitations,outcome,issuedAt:now(),expiresAt:request.expiresAt,commission:fee?{taskId:link.commissionTaskId,payment:fee}:null,authority:'advisory_only'};
     value.hash=digest(value);await countRecord(tx);await tx.write('task-review-reports',reviewId,value,0);
     const task=await update(tx,row,{...row.value.review,state:'reviewed',outcome,reportHash:value.hash},who,'task.review.submitted');return {task,report:value};
    });});
  },
  async challenge(actor,projectId,{taskId,reviewId,reason,evidence:items,idempotencyKey}){
   return storage.transaction(projectId,async tx=>{const {who}=await participant(tx,projectId,actor);
    return effect(tx,projectId,actor,'task.review.challenge',idempotencyKey,{taskId,reviewId,reason,evidence:items},async()=>{
     const row=await publicTask(tx,projectId,taskId);requireThat(row.value.review?.id===reviewId&&[row.value.authorId,row.value.assigneeId].includes(who),'scope_denied');
     requireThat(await tx.read('task-review-reports',reviewId),'task_review_not_submitted');const key=digest({reviewId,who});
     requireThat(!await tx.read('task-review-challenges',key),'task_review_already_challenged');bounded(reason,4000);const attached=evidence(items);
     const value={profile,reviewId,taskId,authorId:who,reason,evidence:attached,at:now(),authority:'objection_only_not_onchain_dispute'};value.hash=digest(value);
     await countRecord(tx);await tx.write('task-review-challenges',key,{...value,parentId:reviewId},0);
     const task=await update(tx,row,{...row.value.review,challenged:true},who,'task.review.challenged');return {task,challenge:value};
    });});
  },
  async read(projectId,taskId){
   return storage.transaction(projectId,async tx=>{const row=await publicTask(tx,projectId,taskId),task=row.value;
    const request=task.review?(await tx.read('task-reviews',task.review.id))?.value:null;
    const report=request?(await tx.read('task-review-reports',request.id))?.value:null;
    const challenges=request?(await tx.list('task-review-challenges',{parentId:request.id,limit:2})).map(r=>r.value):[];
    const link=request?(await tx.read('task-review-commissions',request.id))?.value:null;
    const linked=link?await tx.read('tasks',link.commissionTaskId):null,commission=linked&&!linked.value.hidden?linked:null;
    return {profile,projectId,taskId,taskRevision:row.revision,policy:task.reviewPolicy??null,request:request??null,report:report??null,challenges,commission:commission?{taskId:commission.value.id,state:commission.value.state,agreement:commission.value.agreement??null}:null,
     current:!!request&&task.state==='submitted'&&digest(binding(task))===request.bindingHash&&now()<request.expiresAt,observedAt:now(),authority:'advisory_only',settlement:'Review and objections do not sign payments or pause escrow deadlines. The buyer signs acceptance. Use the original onchain dispute before its deadline for disputed funds.'};
   });
  },
  async receipt(tx,task){
   if(!task.review)return null;
   const r=(await tx.read('task-review-reports',task.review.id))?.value,challenges=(await tx.list('task-review-challenges',{parentId:task.review.id,limit:2})).map(r=>r.value.hash);
   return {id:task.review.id,reportHash:r?.hash??null,outcome:r?.outcome??null,challenges,authority:'advisory_only'};
  }
 };
 return api;
}
