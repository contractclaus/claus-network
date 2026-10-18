import {randomUUID} from 'node:crypto';
// Run one owner-supplied handler. The caller persists claimRequestId before
// invoking this function and retains it after an unknown transport outcome.
export async function runQueueWorker({origin,token,resourceId,workerId,claimRequestId,leaseSeconds=300,handler,request=fetch}){
 if(typeof handler!=='function'||!claimRequestId||leaseSeconds<30||leaseSeconds>900)throw Error('worker_configuration_invalid');
 const base=new URL(origin);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw Error('worker_origin_invalid');
 const rpc=async(operation,input,requestId)=>{
  const body=JSON.stringify({operation,input,requestId});let failure;
  for(let attempt=0;attempt<2;attempt++)try{
   const r=await request(new URL('/api/resources',base),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body,redirect:'error',signal:AbortSignal.timeout(20000)});
   const value=await r.json();if(!r.ok){const e=Error(/^resource_[a-z0-9_]+$/.test(value.error??'')?value.error:'worker_broker_rejected');e.definitive=true;throw e;}return value.result;
  }catch(e){if(e.definitive)throw e;failure=e;}
  throw Error('worker_broker_outcome_unknown',{cause:failure});
 };
 const claim=await rpc('worker_claim',{resourceId,workerId,leaseSeconds},claimRequestId);
 if(claim.state!=='claimed')return claim;
 const abort=new AbortController();let timer,renewing=false,checkpointRevision=claim.checkpoint?.revision??0,leaseUntil=claim.leaseUntil,checkpointing=false;
 const input={resourceId,jobId:claim.jobId,claimId:claim.claimId};
 const heartbeat=async()=>{
  if(abort.signal.aborted||renewing)return;renewing=true;
  try{const r=await rpc('worker_renew',{...input,leaseSeconds},randomUUID());leaseUntil=r.job.leaseUntil;}
  catch{abort.abort(Error('worker_lease_not_confirmed'));}finally{renewing=false;}
 };
 timer=setInterval(()=>{if(Date.now()>=leaseUntil)abort.abort(Error('worker_lease_expired'));else void heartbeat();},Math.max(5000,Math.floor(leaseSeconds*1000/3)));
 try{
  const output=await handler({arguments:claim.arguments,checkpoint:claim.checkpoint?.data??null,jobId:claim.jobId,stableEffectPrefix:claim.stableEffectPrefix,signal:abort.signal,
   async saveCheckpoint(data){if(abort.signal.aborted)throw abort.signal.reason;if(checkpointing)throw Error('worker_checkpoint_in_progress');checkpointing=true;try{const r=await rpc('worker_checkpoint',{...input,expectedCheckpoint:checkpointRevision,data},randomUUID());checkpointRevision=r.job.checkpoint.revision;return checkpointRevision;}finally{checkpointing=false;}}
  });
  if(abort.signal.aborted)throw abort.signal.reason;if(!output||!['succeeded','failed'].includes(output.state))throw Error('worker_explicit_result_required');
  return await rpc('worker_finish',{...input,state:output.state,output:output.output},randomUUID());
 }finally{clearInterval(timer);abort.abort();}
}
