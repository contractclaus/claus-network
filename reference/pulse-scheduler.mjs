import {digest,integer,requireThat} from '../src/shared/index.mjs';

// One active reference run per project. All durable work and checkpoints use
// the network's existing leased jobs; this cursor only schedules the next run.
export function createPulseScheduler({store,jobs,pipeline,config,now=Date.now}){
 integer(config.intervalMs,3600000,86400000);integer(config.maximumRuns,1,168);
 integer(config.expiresAt,1);integer(config.startsAt,1);
 const kind='reference-pulse:'+config.projectId,key=config.projectId,configHash=digest(config);
 async function schedule(){
  return store.transaction(async tx=>{
   const row=await tx.read('reference-pulse-schedules',key),old=row?.value;
   if(old)requireThat(old.configHash===configHash,'reference_schedule_changed');
   if(old?.activeJobId){
    const active=(await tx.read('workflow-jobs',old.activeJobId))?.value;
    requireThat(active?.kind===kind,'reference_job_missing');
    if(!['complete','failed','cancelled'].includes(active.state))return active.id;
   }
   const slot=Math.floor((now()-config.startsAt)/config.intervalMs);
   if(slot<0||now()>=config.expiresAt||slot<= (old?.lastSlot??-1)||(old?.runs??0)>=config.maximumRuns)return null;
   const id=key+':'+slot;
   const run={id,slot,state:'queued',expiresAt:Math.min(now()+config.intervalMs,config.expiresAt),
    serviceExpiresAt:config.expiresAt};
   const job=await jobs.enqueue(tx,{projectId:key,kind,payload:run,idempotencyKey:id,authority:{configHash}});
   await tx.write('reference-pulse-schedules',key,{configHash,config,activeJobId:job.id,lastSlot:slot,runs:(old?.runs??0)+1},row?.revision??0);
   return job.id;
  });
 }
 return {async tick(){
  await schedule();
  const claim=await jobs.claim({kinds:[kind],leaseMs:300000});
  if(claim.idle)return {state:now()>=config.expiresAt?'expired':'ready'};
  let run=claim.job.result?.run??claim.job.payload;
  const checkpoint=async next=>store.transaction(async tx=>{
   await jobs.assertCurrent(claim,tx);
   const row=await tx.read('workflow-jobs',claim.id);run=structuredClone(next);
   await tx.write('workflow-jobs',claim.id,{...row.value,result:{run},updatedAt:now()},row.revision);
  });
  try{
   if(claim.mode==='dispatch')await jobs.beginEffect(claim,async()=>now()<config.expiresAt);
   const result=await pipeline.step(run,checkpoint);run=result;
   const state=['complete','failed'].includes(run.state)?run.state:'waiting';
   await jobs.finish(claim,{state,result:{run},...(state==='waiting'?{retryAt:now()+30000}:{})});
   return {state,runId:run.id,transactionHash:run.transactionHash??null};
  }catch(error){
   if(error.code==='lease_lost')throw error;
   // Only a durable signed transaction may own the lane indefinitely. An
   // unsigned API intent cannot block all later slots after expiry or denial.
   const signed=run.write?.operation&&await store.read('chain-transactions','signal-record:'+run.write.operation.id);
   const receiptState=signed&&['confirmed','reverted'].includes(signed.value.state);
   const apiOperation=receiptState&&await store.read('signal-operations',run.write.operation.id);
   // A finalized receipt is not a completed API handoff. Preserve retries
   // through an API outage until the original hash and terminal outcome land.
   const unreportedReceipt=receiptState&&signed.value.hash&&
    (apiOperation?.value.transactionHash!==signed.value.hash||!['confirmed','failed'].includes(apiOperation?.value.state));
   const unresolved=unreportedReceipt||signed&&!['confirmed','reverted','cancelled'].includes(signed.value.state);
   const terminal=!unresolved&&(
    run.expiresAt<=now()||['pulse_service_failed','pulse_publication_withdrawn','pulse_rule_changed',
     'pulse_source_changed','pulse_result_expiring','public_result_unavailable','signal_grant_inactive','signal_grant_exhausted',
     'transaction_not_authorized','signal_budget_exhausted','signal_budget_changed','scope_denied',
     'signal_not_enabled','signal_operation_mismatch','signal_data_expired','signal_stale_version'].includes(error.code));
   await jobs.finish(claim,{state:terminal?'failed':'waiting',result:{run,error:error.code??'reference_unavailable'},
    ...(!terminal?{retryAt:now()+60000}:{})});
   return {state:terminal?'failed':'unavailable',runId:run.id,error:error.code??'reference_unavailable'};
  }
 }};
}
