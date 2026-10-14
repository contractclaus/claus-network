import test from 'node:test';import assert from 'node:assert/strict';
import {keccak256,decodeFunctionData,encodeFunctionData} from 'viem';
import {fixture} from './apps-fixture.mjs';
import {dealPorts} from '../runtime/deal-ports.mjs';
import {tokenDealAbi,paymentTokenAbi} from '../src/deals/token-abi.mjs';
import {digest} from '../src/shared/index.mjs';
import {oracleInput,validateDealDecisionShape} from '../src/deals/decision.mjs';
const hash=v=>'0x'+digest(v).slice(7),eth='0x'+'11'.repeat(20),escrow='0x'+'22'.repeat(20),token='0x'+'33'.repeat(20),arbiter='0x'+'44'.repeat(20),controller='0x'+'55'.repeat(20),worker='0x'+'66'.repeat(20);
const stamp=Math.floor(Date.now()/1000),code='0x6001';
function setupPorts(){
 const state={enabled:true,allowance:0n,balance:1000n,locked:0n,credits:0n,token,deal:null,calls:[]};
 const pins=[{chainId:1,contract:eth,codeHash:keccak256(code),arbiter,admissionController:controller,maximumDealWei:'100',reviewed:true},{chainId:1,asset:'CLAUS',contract:escrow,token,decimals:18,minimumReviewUnits:'1',codeHash:keccak256(code),arbiter,admissionController:controller,maximumDealWei:'100',reviewed:true}];
 const client={getChainId:async()=>1,getBlock:async()=>({number:100n,hash:hash('block'),timestamp:BigInt(stamp)}),getBytecode:async()=>code,
 readContract:async({address,functionName,args})=>{
  state.calls.push({address,functionName,args});
  const fields={arbiter,admissionController:controller,maximumDeal:100n,maximumPrincipal:500n,fundingEnabled:state.enabled,token:state.token,decimals:18,balanceOf:state.balance,allowance:state.allowance,totalLocked:state.locked,totalCredits:state.credits,credits:address===eth?7n:9n};
  if(functionName==='dealId'||functionName==='planId')return hash({address,args});
  if(functionName==='getDeal')return state.deal??{buyer:'0x'+'00'.repeat(20)};
  return fields[functionName];
 },simulateContract:async()=>({}),estimateContractGas:async()=>50000n};
 const ports=dealPorts({CLAUS_DEAL_PINS:JSON.stringify(pins),CLAUS_MAINNET_RPC_URL:'https://rpc.example/'},{clientFactory:()=>client});
 return {ports,state,pins,client};
}
test('asset selector isolates credits and immutable token pins; it never falls back to ETH',async t=>{
 const {ports,state}=setupPorts(),f=await fixture(t,{dealPorts:ports});
 assert.equal((await f.owner.call('deal_balance',{chainId:1,address:worker})).creditWei,'7');
 const credit=await f.owner.call('deal_balance',{chainId:1,address:worker,asset:'CLAUS'});assert.equal(credit.creditWei,'9');assert.equal(credit.asset,'CLAUS');assert.equal(credit.contract,escrow);
 await assert.rejects(f.owner.call('deal_terms',{chainId:1,asset:'OTHER'}),e=>e.code==='invalid_input');
 const wrong=setupPorts();wrong.state.token=worker;await assert.rejects(wrong.ports.context(1,{asset:'CLAUS'}),e=>e.code==='deal_pin_mismatch');
 const absent=dealPorts({CLAUS_DEAL_PINS:JSON.stringify(setupPorts().pins.slice(0,1)),CLAUS_MAINNET_RPC_URL:'https://rpc.example/'},{clientFactory:()=>setupPorts().client});
 await assert.rejects(absent.context(1,{asset:'CLAUS'}),e=>e.code==='deals_not_enabled');
});
test('CLAUS funding returns exact approval, then zero-ETH deposit; wrong balances and capacity block before approval',async t=>{
 const {ports,state}=setupPorts(),f=await fixture(t,{dealPorts:ports});
 const input={projectId:f.project.id,chainId:1,asset:'CLAUS',action:'fund',input:{salt:hash('salt'),termsHash:hash('terms'),worker,priceWei:'100',deliveryDue:stamp+3600}};
 const approval=await f.owner.call('deal_prepare',input);assert.equal(approval.state,'approval-required');assert.equal(approval.transaction.to,token);assert.equal(approval.transaction.value,'0');assert.deepEqual(decodeFunctionData({abi:paymentTokenAbi,data:approval.transaction.data}).args,[escrow,100n]);
 state.allowance=100n;const deposit=await f.owner.call('deal_prepare',input);assert.equal(deposit.id,approval.id);assert.equal(deposit.state,'prepared-not-sent');assert.equal(deposit.transaction.to,escrow);assert.equal(deposit.transaction.value,'0');assert.equal(decodeFunctionData({abi:tokenDealAbi,data:deposit.transaction.data}).args[4],100n);
 state.allowance=0n;state.balance=99n;await assert.rejects(f.owner.call('deal_prepare',input),e=>e.code==='insufficient_deal_token_balance');state.balance=1000n;state.credits=450n;await assert.rejects(f.owner.call('deal_prepare',input),e=>e.code==='deal_capacity_reached');
});
test('linked CLAUS task freezes the asset, exact amount, approval step and delivery payment evidence',async t=>{
 const {ports,state}=setupPorts(),f=await fixture(t,{dealPorts:ports}),projectId=f.project.id;
 const workerProject=await f.bob.call('project_create',{slug:'token-worker',name:'Worker',idempotencyKey:'worker'});
 let task=await f.owner.call('app_task_post',{projectId,input:{text:'Produce 6.'},idempotencyKey:'task'});
 task=await f.bob.call('app_task_claim',{projectId,taskId:task.id,expectedRevision:task.revision,idempotencyKey:'claim'});
 const agree={projectId,taskId:task.id,payerProjectId:projectId,asset:'CLAUS',chainId:1,priceWei:'100',deliveryDue:stamp+3600,expectedRevision:task.revision,idempotencyKey:'agreement'};
 task=await f.owner.call('app_task_agreement',agree);assert.equal(task.agreement.asset,'CLAUS');assert.equal(task.agreement.token,token);assert.equal(JSON.parse(task.agreement.terms.text).asset,'CLAUS');
 await assert.rejects(f.owner.call('app_task_agreement',{...agree,asset:'ETH'}),e=>e.code==='idempotency_conflict');
 const prepare=(client,action,senderProjectId)=>client.call('app_task_payment_prepare',{projectId,taskId:task.id,senderProjectId,action});
 assert.equal((await prepare(f.owner,'fund',projectId)).state,'approval-required');state.allowance=100n;
 const tx=await prepare(f.owner,'fund',projectId),args=decodeFunctionData({abi:tokenDealAbi,data:tx.transaction.data}).args;
 state.deal={buyer:tx.transaction.from,worker:args[3],amount:'100',projectId:args[1],termsHash:args[2],deliveryDue:args[5],state:1,resultHash:hash('empty'),workerPaid:'0'};
 assert.equal((await prepare(f.owner,'fund',projectId)).transaction,null);
 await prepare(f.bob,'claim',workerProject.id);state.deal.state=2;
 task=await f.bob.call('app_task_deliver',{projectId,taskId:task.id,generation:task.generation,expectedRevision:task.revision,output:{text:'6'},idempotencyKey:'delivery'});
 const delivery=await prepare(f.bob,'deliver',workerProject.id);state.deal.resultHash=decodeFunctionData({abi:tokenDealAbi,data:delivery.transaction.data}).args[1];state.deal.state=3;state.deal.reviewDue=stamp+86400;
 task=await f.owner.call('app_task_accept',{projectId,taskId:task.id,expectedRevision:task.revision,idempotencyKey:'accept'});assert(task.receipt.payment);
 const accepted=await prepare(f.owner,'accept',projectId);assert.equal(accepted.transaction.to,escrow);assert.equal(accepted.transaction.value,'0');
});
test('dispute oracle retains ETH wording for old cases and explicitly denominates CLAUS cases',()=>{
 const base={id:hash('case'),chainId:1,contract:escrow,deal:{amount:'100'},observation:{blockNumber:'100'}};
 const native=oracleInput(base),claus=oracleInput({...base,observation:{...base.observation,asset:'CLAUS',token}});
 assert.match(native.question,/native ETH wei/);assert.match(claus.question,/CLAUS base units/);assert.match(claus.definitions.amount,/10\^18/);assert(!claus.question.includes('native ETH'));
 assert.deepEqual(claus.guards,native.guards);assert.equal(claus.consumer.verifyingContract,escrow);
});

test('documented ETH default has the same agreement idempotency binding as omitted asset',async t=>{
 const {ports}=setupPorts(),f=await fixture(t,{dealPorts:ports}),projectId=f.project.id;
 for(const explicitFirst of [false,true]){
  const key=String(explicitFirst);let task=await f.owner.call('app_task_post',{projectId,input:{text:'Produce 6.'},idempotencyKey:'default-task-'+key});
  task=await f.bob.call('app_task_claim',{projectId,taskId:task.id,expectedRevision:task.revision,idempotencyKey:'default-claim-'+key});
  const input={projectId,taskId:task.id,payerProjectId:projectId,chainId:1,priceWei:'100',deliveryDue:stamp+3600,expectedRevision:task.revision,idempotencyKey:'default-agreement-'+key};
  const first=await f.owner.call('app_task_agreement',{...input,...(explicitFirst?{asset:'ETH'}:{})});
  assert.deepEqual(await f.owner.call('app_task_agreement',{...input,...(explicitFirst?{}:{asset:'ETH'})}),first);
  await assert.rejects(f.owner.call('app_task_agreement',{...input,asset:'CLAUS'}),e=>e.code==='idempotency_conflict');
 }
});
test('paused CLAUS funding is a state error and the same input works after reopening',async t=>{
 const {ports,state}=setupPorts(),f=await fixture(t,{dealPorts:ports});const input={projectId:f.project.id,chainId:1,asset:'CLAUS',action:'fund',input:{salt:hash('paused'),termsHash:hash('terms'),worker,priceWei:'100',deliveryDue:stamp+3600}};
 state.enabled=false;await assert.rejects(f.owner.call('deal_prepare',input),e=>e.code==='deals_not_enabled');state.enabled=true;assert.equal((await f.owner.call('deal_prepare',input)).state,'approval-required');
});
