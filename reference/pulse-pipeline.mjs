import {digest,requireThat} from '../src/shared/index.mjs';

// One finite run: Observer order -> Evaluator order -> Consumer store write.
// The consumer's last step is an onchain operation, not a fabricated purchase
// from itself. Each effect keeps its original ID across process restarts.
export function createPulsePipeline({client,projectId,observerServiceId,evaluatorServiceId,consumerProvider,publisher,
 grantId,signal,readRule,now=Date.now}) {
 const call=(name,args={})=>client.call(name,{projectId,...args});
 async function publicResult(order,expiresAt){
   requireThat(expiresAt>now()+1000,'pulse_result_expiring');
  const state=await call('service_result_publication',{orderId:order.id});
  if(state.revision>0){
   requireThat(state.published&&state.outputHash===order.outputHash&&state.expiresAt>=expiresAt,'pulse_publication_withdrawn');
   return {id:order.id,revision:state.revision,outputHash:order.outputHash};
  }
  const saved=await call('service_result_publish',{orderId:order.id,outputHash:order.outputHash,published:true,
   expiresAt,expectedRevision:state.revision});
  return {id:order.id,revision:saved.revision,outputHash:order.outputHash};
 }
 async function service(run,key,serviceId,input,sources,checkpoint){
  const step=run[key]??={};
  if(!step.request){step.request={serviceId,input,sourceResults:sources,idempotencyKey:run.id+':'+key};await checkpoint(run);}
  if(!step.quote){step.quote=await call('service_quote',step.request);requireThat(step.quote.maximumWei==='0','pulse_service_not_free');await checkpoint(run);}
  if(!step.order){step.order=await call('service_accept',{quoteId:step.quote.id});await checkpoint(run);}
  const order=await call('service_order',{orderId:step.order.id});
  requireThat(!['cancelled','expired','failed'].includes(order.state),'pulse_service_failed');
  if(order.state!=='delivered')return null;
  const output=await call('service_result',{orderId:order.id});requireThat(output.status==='ok'&&digest(output)===order.outputHash,'pulse_result_invalid');
  await call('service_accept_result',{orderId:order.id,outputHash:order.outputHash,accepted:true});
  // Fresh-work deadline and observation validity are distinct. An hourly run
  // may publish a two-hour observation so finality does not create a gap.
  if(!step.expiresAt){
   const observedAt=output.observedAt??output.observation?.observedAt;
   requireThat(Number.isSafeInteger(observedAt),'pulse_result_invalid');
   step.expiresAt=Math.min((observedAt+run.rule.maximumAge)*1000,run.serviceExpiresAt);await checkpoint(run);
  }
  const ref=await publicResult(order,step.expiresAt);
  step.output=output;step.ref=ref;await checkpoint(run);return step;
 }
 return {async step(run,checkpoint){
  // A broadcast is reconciled before expiry, source permission or fresh-work
  // checks. Nothing below replaces a transaction whose outcome is unknown.
  if(run.write?.operation){
   const outcome=await publisher.step(run.write.operation);
   if(outcome.transactionHash)await call('signal_submit',{operationId:run.write.operation.id,transactionHash:outcome.transactionHash});
   if(outcome.state==='failed'){run.state='failed';run.error=outcome.error;await checkpoint(run);return run;}
   if(outcome.state!=='confirmed')return {...run,state:'waiting'};
   const operation=await call('signal_operation',{operationId:run.write.operation.id});
   if(operation.state!=='confirmed')return {...run,state:'waiting'};
   run.state='complete';run.transactionHash=operation.transactionHash;run.completedAt=now();await checkpoint(run);return run;
  }
  requireThat(run.expiresAt>now(),'pulse_run_expired');
  if(!run.rule){run.rule=await readRule();await checkpoint(run);}
  if(!run.grantExpiresAt){
   const grant=await call('signal_grant',{grantId});
   requireThat(grant.finalized&&!grant.revoked&&!grant.apiRevoked,'signal_grant_inactive');
   run.grantExpiresAt=Number(grant.terms.expiresAt)*1000;
   requireThat(Number.isSafeInteger(run.grantExpiresAt)&&run.grantExpiresAt>now(),'signal_grant_inactive');
   run.serviceExpiresAt=Math.min(run.serviceExpiresAt,run.grantExpiresAt);await checkpoint(run);
  }
  const observer=await service(run,'observer',observerServiceId,{chainId:signal.chainId},[],checkpoint);
  if(!observer)return {...run,state:'waiting'};
  const evaluator=await service(run,'evaluator',evaluatorServiceId,{observation:observer.output,thresholdWei:run.rule.thresholdWei,
   ruleVersion:run.rule.version},[observer.ref],checkpoint);
  if(!evaluator)return {...run,state:'waiting'};
  const consumed=await consumerProvider.execute({evaluation:evaluator.output});
  requireThat(consumed.ruleVersion===run.rule.version&&consumed.thresholdWei===run.rule.thresholdWei,'pulse_rule_changed');
  const current=await readRule();requireThat(digest(current)===digest(run.rule),'pulse_rule_changed');
  const publication=await client.call('public_service_result',{orderId:evaluator.ref.id});
  requireThat(publication.revision===evaluator.ref.revision&&publication.outputHash===evaluator.ref.outputHash,'pulse_source_changed');
  if(!run.write){
   const latest=await call('signal_latest');
   requireThat(latest.finalized===true,'signal_not_finalized');
   const input={grantId,sequence:Number(latest.record.sequence)+1,expectedVersion:run.rule.version,
    observedAt:consumed.observation.observedAt,validUntil:Math.min(consumed.observation.observedAt+run.rule.maximumAge,
      Math.floor(run.serviceExpiresAt/1000)),sourceResult:evaluator.ref,data:consumed.onchainData,idempotencyKey:run.id};
   requireThat(input.validUntil>Math.floor(now()/1000)+900,'pulse_result_expiring');
   run.write={input};await checkpoint(run);
  }
  // With a lost prepare response, this exact saved body recovers the same ID.
  try { run.write.operation=await call('signal_record_prepare',run.write.input); }
  catch(error) {
   // This definitive pre-acceptance failure has no operation or signature.
   // A lost response is not cleared and still reuses its exact original body.
   if(error.code==='signal_stale_sequence'){delete run.write;await checkpoint(run);}
   throw error;
  }await checkpoint(run);
  return {...run,state:'waiting'};
 }};
}
