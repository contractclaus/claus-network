import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './apps-fixture.mjs';import {digest} from '../src/shared/index.mjs';
import {encodeFunctionData} from 'viem';import {dealAbi} from '../src/deals/index.mjs';
async function setup(t,provided={}){
 const f=await fixture(t,provided),projectId=f.project.id,reviewerId=(await f.eve.call('principal_me')).principal.id;
 const reviewPolicy={reviewerId,selectionBasis:'Selected for arithmetic verification; no known common controller.',criteria:[{id:'sum',description:'The result must be 6, the sum of 2 and 4.'}]};
 const post=()=>f.owner.call('app_task_post',{projectId,input:{text:'Add 2 and 4'},reviewPolicy,idempotencyKey:'reviewed-task'});
 let task=await post();const claim=()=>f.bob.call('app_task_claim',{projectId,taskId:task.id,expectedRevision:task.revision,idempotencyKey:'claim'});
 const deliver=()=>f.bob.call('app_task_deliver',{projectId,taskId:task.id,generation:task.generation,output:{text:'6'},expectedRevision:task.revision,idempotencyKey:'deliver'});
 const request=()=>f.owner.call('app_task_review_request',{projectId,taskId:task.id,expectedRevision:task.revision,expiresAt:Date.now()+60000,evidence:[],idempotencyKey:'request'});
 const report=req=>({criteria:[{id:'sum',outcome:'pass',rationale:'Recomputed 2 + 4 = 6; this matches the frozen delivered output.',evidenceHashes:[req.binding.outputHash]}],evidence:[],conflicts:'No known conflict.',limitations:'Verifies the arithmetic in this delivery only.'});
 return {...f,projectId,reviewPolicy,claim,deliver,request,report,post,get:()=>task,set:v=>task=v};
}
test('frozen evidence, authenticated report, objections and acceptance remain separate and replay-safe',async t=>{
 const f=await setup(t);f.set(await f.claim());f.set(await f.deliver());const r=await f.request(),reviewId=r.request.id,taskId=f.get().id,projectId=f.projectId;
 assert.equal(r.request.binding.outputHash,digest({text:'6'}));const input={projectId,taskId,reviewId,report:f.report(r.request),idempotencyKey:'submit'};
 await assert.rejects(f.bob.call('app_task_review_submit',input),e=>e.code==='scope_denied');
 const submitted=await f.eve.call('app_task_review_submit',input);assert.equal(submitted.task.state,'submitted');assert.equal(submitted.report.authority,'advisory_only');
 assert.deepEqual(await f.eve.call('app_task_review_submit',input),submitted);
 await assert.rejects(f.eve.call('app_task_review_submit',{...input,idempotencyKey:'second'}),e=>e.code==='task_review_already_submitted');
 const objection=await f.bob.call('app_task_review_challenge',{projectId,taskId,reviewId,reason:'Recorded objection for internal verification.',evidence:[],idempotencyKey:'objection'});
 const accepted=await f.owner.call('app_task_accept',{projectId,taskId,expectedRevision:objection.task.revision,idempotencyKey:'accept'});
 assert.equal(accepted.receipt.review.reportHash,submitted.report.hash);assert.equal(accepted.receipt.review.challenges.length,1);
 const current=await f.owner.call('public_task_review',{projectId,taskId});assert.equal(current.current,false);assert.equal(current.report.outcome,'pass');assert.equal(current.challenges.length,1);
 assert.deepEqual(await f.eve.call('app_task_review_submit',input),submitted); // A retry cannot create another report after acceptance.
});
test('reviewer and known controller cannot claim work; evidence and expiry are enforced',async t=>{
 const f=await setup(t),projectId=f.projectId,taskId=f.get().id;
 await assert.rejects(f.eve.call('app_task_claim',{projectId,taskId,expectedRevision:f.get().revision,idempotencyKey:'self'}),e=>e.code==='task_review_conflict');
 f.set(await f.claim());f.set(await f.deliver());const r=await f.request(),report=f.report(r.request);
 report.criteria[0].evidenceHashes=['sha256:'+'0'.repeat(64)];
 await assert.rejects(f.eve.call('app_task_review_submit',{projectId,taskId,reviewId:r.request.id,report,idempotencyKey:'wrong-evidence'}),e=>e.code==='task_review_evidence_missing');
 f.advance(120000);
 await assert.rejects(f.eve.call('app_task_review_submit',{projectId,taskId,reviewId:r.request.id,report:f.report(r.request),idempotencyKey:'late'}),e=>e.code==='task_review_expired');
 const read=await f.eve.call('public_task_review',{projectId,taskId});assert.equal(read.current,false);assert.equal(read.report,null);
});
test('shared project controllers and stale task state cannot pass as independent review',async t=>{
 const f=await setup(t),ownerId=(await f.owner.call('principal_me')).principal.id;
 await f.store.transaction(tx=>tx.write('principals','agent-related',{id:'agent-related',projectId:f.projectId},0));
 await assert.rejects(f.owner.call('app_task_post',{projectId:f.projectId,input:{text:'Related reviewer'},reviewPolicy:{...f.reviewPolicy,reviewerId:'agent-related'},idempotencyKey:'related'}),e=>e.code==='task_review_conflict');
 assert.notEqual(ownerId,f.reviewPolicy.reviewerId);f.set(await f.claim());f.set(await f.deliver());const r=await f.request();
 await f.owner.call('app_task_cancel',{projectId:f.projectId,taskId:f.get().id,expectedRevision:r.task.revision,idempotencyKey:'cancel'});
 await assert.rejects(f.eve.call('app_task_review_submit',{projectId:f.projectId,taskId:f.get().id,reviewId:r.request.id,report:f.report(r.request),idempotencyKey:'stale'}),e=>e.code==='task_review_stale');
});
test('public visibility and scoped browser credentials apply to review artifacts',async t=>{
 const f=await setup(t),projectId=f.projectId;f.set(await f.claim());f.set(await f.deliver());const r=await f.request();
 const token=await f.eve.call('app_session_create',{projectId,actions:['app_task_review_submit'],expiresAt:Date.now()+60000});
 const input={projectId,taskId:f.get().id,reviewId:r.request.id,report:f.report(r.request),idempotencyKey:'browser-review'};
 assert.equal((await f.app.service.execute('app_task_review_submit',input,token.token)).report.outcome,'pass');
 await assert.rejects(f.app.service.execute('app_task_review_commission',{projectId,taskId:f.get().id,reviewId:r.request.id,commissionTaskId:'x',expectedRevision:1,idempotencyKey:'escalation'},token.token),e=>e.code==='scope_denied');
 const app=await f.owner.call('app_get',{projectId});await f.owner.call('app_publish',{projectId,published:false,expectedRevision:app.revision,idempotencyKey:'unpublish'});
 await assert.rejects(f.eve.call('public_task_review',{projectId,taskId:f.get().id}),e=>e.code==='not_found');
});
test('separate ETH commission binds the review and pays for a report regardless of verdict',async t=>{
 const contract='0x'+'11'.repeat(20),codeHash='0x'+'22'.repeat(32),arbiter='0x'+'33'.repeat(20);let value=null,last;
 const ports={context:async chainId=>({public:{enabled:true,chainId,contract,codeHash,arbiter,maximumDealWei:'1000',blockNumber:'8',blockHash:'0x'+'44'.repeat(32),observedBlockTime:String(Math.floor(Date.now()/1000))}}),id:async(c,k,sender,salt)=>'0x'+digest({sender,salt}).slice(7),read:async()=>{if(!value)throw Object.assign(Error('not_found'),{code:'not_found'});return {...value};},prepare:async(c,v)=>{last=v;return {transaction:{chainId:c.public.chainId,from:v.sender,to:contract,value:String(v.value),data:encodeFunctionData({abi:dealAbi,functionName:v.method,args:v.args})},gasEstimate:'100000'};}};
 const f=await setup(t,{dealPorts:ports}),projectId=f.projectId;f.set(await f.claim());f.set(await f.deliver());const req=await f.request(),taskId=f.get().id,reviewId=req.request.id;
 let commission=await f.owner.call('app_task_post',{projectId,input:{text:'Review arithmetic evidence; compensation is independent of verdict.'},idempotencyKey:'commission'});
 commission=await f.eve.call('app_task_claim',{projectId,taskId:commission.id,expectedRevision:commission.revision,idempotencyKey:'claim-review'});
 commission=await f.owner.call('app_task_review_commission',{projectId,taskId,reviewId,commissionTaskId:commission.id,expectedRevision:commission.revision,idempotencyKey:'link-review'});
 const report=f.report(req.request);report.criteria[0].outcome='fail';report.criteria[0].rationale='Internal negative verdict fixture.';const input={projectId,taskId,reviewId,report,idempotencyKey:'paid-report'};
 await assert.rejects(f.eve.call('app_task_review_submit',input),e=>e.code==='task_review_commission_unfunded');
 commission=await f.owner.call('app_task_agreement',{projectId,taskId:commission.id,payerProjectId:projectId,chainId:1,priceWei:'100',deliveryDue:Math.floor(Date.now()/1000)+30,expectedRevision:commission.revision,idempotencyKey:'review-agreement'});
 assert.equal(JSON.parse(commission.agreement.terms.text).reviewCommission.reviewId,reviewId);
 const reviewerProject=await f.eve.call('project_create',{slug:'reviewer-wallet',name:'Reviewer',idempotencyKey:'reviewer'});
 const prepare=(client,action)=>client.call('app_task_payment_prepare',{projectId,taskId:commission.id,senderProjectId:client===f.owner?projectId:reviewerProject.id,action});
 await prepare(f.owner,'fund');value={buyer:last.sender,worker:last.args[3],amount:String(last.value),projectId:last.args[1],termsHash:last.args[2],deliveryDue:last.args[4],state:2,resultHash:'0x'+'00'.repeat(32),workerPaid:'0'};
 await assert.rejects(f.eve.call('app_task_deliver',{projectId,taskId:commission.id,generation:commission.generation,output:{text:'Review done'},expectedRevision:commission.revision,idempotencyKey:'before-report'}),e=>e.code==='task_review_not_submitted');
 // Closing the original work must not erase the separate reviewer's paid obligation.
 await f.owner.call('app_task_cancel',{projectId,taskId,expectedRevision:req.task.revision,idempotencyKey:'close-original'});
 const result=await f.eve.call('app_task_review_submit',input);assert.equal(result.report.outcome,'fail');assert.equal(result.task.state,'cancelled');assert.equal(result.report.sourceCurrent,false);
 commission=await f.eve.call('app_task_deliver',{projectId,taskId:commission.id,generation:commission.generation,output:{text:result.report.hash},expectedRevision:commission.revision,idempotencyKey:'deliver-report'});
 await prepare(f.eve,'deliver');value.state=3;value.resultHash=last.args[1];value.reviewDue=Math.floor(Date.now()/1000)+86400;
 commission=await f.owner.call('app_task_accept',{projectId,taskId:commission.id,expectedRevision:commission.revision,idempotencyKey:'accept-report'});
 await prepare(f.owner,'accept');assert.equal(last.method,'accept');assert.equal(last.value,0n);
});
