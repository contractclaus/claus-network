import test from 'node:test';import assert from 'node:assert/strict';
import {encodeFunctionData} from 'viem';import {fixture} from './apps-fixture.mjs';
import {digest} from '../src/shared/index.mjs';import {dealAbi} from '../src/deals/index.mjs';
const hash=v=>'0x'+digest(v).slice(7),contract='0x'+'11'.repeat(20),codeHash='0x'+'22'.repeat(32),arbiter='0x'+'33'.repeat(20);
async function setup(t){
 let current=null,failRead=false,clock=Math.floor(Date.now()/1000);const requests=[];
 const ports={context:async chainId=>({public:{enabled:true,chainId,contract,codeHash,arbiter,maximumDealWei:'1000',blockNumber:'8',blockHash:hash('block'),observedBlockTime:String(clock)}}),
 id:async(c,senderKind,sender,salt)=>hash({sender,salt}),
 read:async()=>{if(failRead)throw Error('network unavailable');if(!current)throw Object.assign(Error('not_found'),{code:'not_found'});return {...current};},
 prepare:async(c,v)=>{requests.push(v);return{transaction:{chainId:c.public.chainId,from:v.sender,to:contract,value:String(v.value),data:encodeFunctionData({abi:dealAbi,functionName:v.method,args:v.args})},gasEstimate:'100000'};}};
 const f=await fixture(t,{dealPorts:ports}),projectId=f.project.id;
 const workerProject=await f.bob.call('project_create',{slug:'worker-wallet',name:'Worker',idempotencyKey:'worker'});
 let task=await f.owner.call('app_task_post',{projectId,input:{text:'Return the sum of 2 and 4.'},idempotencyKey:'task'});
 task=await f.bob.call('app_task_claim',{projectId,taskId:task.id,expectedRevision:task.revision,idempotencyKey:'claim'});
 const agreementInput={projectId,taskId:task.id,payerProjectId:projectId,chainId:1,priceWei:'100',deliveryDue:clock+3600,expectedRevision:task.revision,idempotencyKey:'agreement'};
 const agree=async()=>task=await f.owner.call('app_task_agreement',agreementInput);
 const payment=()=>f.owner.call('public_task_payment',{projectId,taskId:task.id});
 const prepare=(client,action,senderProjectId=client===f.bob?workerProject.id:projectId)=>client.call('app_task_payment_prepare',{projectId,taskId:task.id,senderProjectId,action});
 const apply=()=>{const v=requests.at(-1);if(v.method==='createDeal')current={buyer:v.sender,worker:v.args[3],amount:String(v.value),projectId:v.args[1],termsHash:v.args[2],deliveryDue:v.args[4],state:1,resultHash:'0x'+'00'.repeat(32),workerPaid:'0'};
 else if(v.method==='claim')current.state=2;else if(v.method==='deliver'){current.state=3;current.resultHash=v.args[1];current.reviewDue=clock+86400;}else if(v.method==='accept'){current.state=5;current.workerPaid=current.amount;}};
 return {...f,projectId,workerProject,agreementInput,agree,payment,prepare,apply,requests,getTask:()=>task,setTask:v=>task=v,mutate:fn=>fn(current),fail:()=>failRead=true,advanceClock:n=>clock+=n};
}
test('linked job keeps one escrow identity through funding, delivery, acceptance and replay',async t=>{
 const f=await setup(t);let task=await f.agree();const {projectId}=f,a=task.agreement;
 assert.deepEqual(await f.owner.call('app_task_agreement',f.agreementInput),task);
 assert.equal((await f.payment()).state,'unfunded');const fund=await f.prepare(f.owner,'fund');assert.equal(fund.id,a.id);f.apply();
 assert.equal((await f.prepare(f.owner,'fund')).transaction,null);
 await f.prepare(f.bob,'claim');f.apply();f.advance(31000); // Original free-task lease has expired; escrow parties remain fixed.
 await assert.rejects(f.eve.call('app_task_claim',{projectId,taskId:task.id,expectedRevision:task.revision,idempotencyKey:'steal'}),e=>e.code==='app_task_busy');
 const input={projectId,taskId:task.id,generation:task.generation,output:{text:'6'},expectedRevision:task.revision,idempotencyKey:'deliver'};
 task=await f.bob.call('app_task_deliver',input);f.setTask(task);assert.deepEqual(await f.bob.call('app_task_deliver',input),task);
 await f.prepare(f.bob,'deliver');f.apply();assert.equal((await f.payment()).state,'submitted');
 task=await f.owner.call('app_task_accept',{projectId,taskId:task.id,expectedRevision:task.revision,idempotencyKey:'accept'});f.setTask(task);
 assert(task.receipt.payment);assert.equal((await f.payment()).state,'submitted'); // Content acceptance is not payment.
 await f.prepare(f.owner,'accept');f.apply();assert.equal((await f.payment()).state,'credited');
 assert.equal((await f.prepare(f.owner,'accept')).transaction,null);assert.equal(f.requests.length,4);
});
test('wrong parties and browser content sessions cannot prepare payment; free cancellation cannot release escrow',async t=>{
 const f=await setup(t),task=await f.agree(),{projectId}=f;
 await assert.rejects(f.prepare(f.bob,'fund'),e=>e.code==='deal_party_required');
 const appSession=await f.owner.call('app_session_create',{projectId,actions:['app_records'],expiresAt:Date.now()+60000});
 await assert.rejects(f.app.service.execute('app_task_payment_prepare',{projectId,taskId:task.id,senderProjectId:projectId,action:'fund'},appSession.token),e=>e.code==='scope_denied');
 await assert.rejects(f.owner.call('app_task_cancel',{projectId,taskId:task.id,expectedRevision:task.revision,idempotencyKey:'cancel'}),e=>e.code==='task_payment_exit_required');
 await assert.rejects(f.bob.call('app_task_deliver',{projectId,taskId:task.id,generation:task.generation,expectedRevision:task.revision,output:{text:'6'},idempotencyKey:'not-funded'}),e=>e.code==='task_payment_not_ready');
});
test('read failures do not erase funding, and changed onchain terms never become the linked payment',async t=>{
 const f=await setup(t);await f.agree();await f.prepare(f.owner,'fund');f.apply();
 f.mutate(v=>v.amount='101');await assert.rejects(f.payment(),e=>e.code==='payment_mismatch');
 f.fail();await assert.rejects(f.payment(),e=>e.code==='service_unavailable');
});
test('expired original leases and changed idempotent agreement inputs are rejected',async t=>{
 const f=await setup(t);f.advance(31000);await assert.rejects(f.agree(),e=>e.code==='app_task_busy');
 const g=await setup(t);await g.agree();await assert.rejects(g.owner.call('app_task_agreement',{...g.agreementInput,priceWei:'101'}),e=>e.code==='idempotency_conflict');
});
