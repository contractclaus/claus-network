import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operatingResultView,toolContent,workProgress,conversationWindow,toolOutcome} from '../src/context.js';
const id='ww_'+'1'.repeat(64),hash='0x'+'2'.repeat(64),address='0x'+'3'.repeat(40);
const input={projectId:'project-a',taskId:'task-a',senderProjectId:'project-a',action:'accept'};
function messages(prior:any={},steps:any[]=[]){return [{role:'system',content:'current rules'},{role:'user',content:JSON.stringify(prior)},...steps];}
function step(call:string,args:any,result:any){return [{role:'assistant',tool_calls:[{id:call,function:{name:'work_wallet',arguments:JSON.stringify(args)}}]},{role:'tool',tool_call_id:call,content:JSON.stringify(result)}];}
const pending={id,status:'pending',input:{operation:'transact',input},transactionHash:hash,receipt:null,next:'Read status with this id.',archiveId:'j_10'};
const confirmed={...pending,status:'confirmed',receipt:{status:'success',transactionHash:hash,blockNumber:'100',blockHash:'0x'+'4'.repeat(64),logs:[{data:'event value'}],logsBloom:'0x'+'0'.repeat(512)},archiveId:'j_11'};

test('broad wallet history defers logs while preserving budgets, holds, errors and original identities',()=>{
 const value={address,chainId:1,balanceWei:'900',creditWei:'100',claus:{balanceUnits:'45',creditUnits:null},policy:{chainId:1,address,gas:'500'},account:{active_id:id,gas_reserved:'20',principal_reserved:'50'},actions:[{...confirmed,created_at:'yesterday'},pending,{id:'ww_'+'5'.repeat(64),status:'failed',error:'original error'}]};
 const before=structuredClone(value),view=JSON.parse(toolContent(value,'j_12'));
 assert.deepEqual(value,before);assert.deepEqual(view.account,value.account);assert.deepEqual(view.policy,value.policy);assert.deepEqual(view.claus,value.claus);
 assert.equal(view.actions.length,3);assert.equal(view.actions[0].created_at,'yesterday');assert.deepEqual(view.actions[0].input,confirmed.input);assert.equal(view.actions[0].receipt.logsDeferred,1);assert.equal(view.actions[0].receipt.logs,undefined);assert.equal(view.actions[1].status,'pending');assert.equal(view.actions[2].error,'original error');assert.equal(view.archiveId,'j_12');
 assert.equal(operatingResultView(confirmed),confirmed);assert.equal(operatingResultView({error:'timeout',outcome:'unknown'}).outcome,'unknown');
 assert.equal(JSON.parse(toolContent(confirmed,'j_11')).receipt.logs[0].data,'event value');
});

test('payment identity and confirmation survive unrelated work and a compacted continuation',()=>{
 const first=workProgress(messages({},step('pay',{operation:'transact',input:JSON.stringify(input)},pending)));
 assert.deepEqual(first.payments[0].request,input);assert.equal(first.payments[0].transactionHash,hash);assert.equal(first.payments[0].status,'pending');
 const reads=Array.from({length:30},(_,n)=>step('read'+n,{operation:'status'}, {address,balanceWei:'900',archiveId:'j_'+(20+n)})).flat();
 const retained=workProgress(messages({continuation:{progress:first}},reads));
 assert.equal(retained.operations.length,24);assert.equal(retained.payments[0].id,id);assert.equal(retained.repeatedReads[0].count,24);
 const finished=workProgress(messages({workProgress:retained},step('status',{operation:'status',input:JSON.stringify({id})},confirmed)));
 assert.equal(finished.payments[0].status,'confirmed');assert.equal(finished.payments[0].operation,'transact');assert.equal(finished.payments[0].request.taskId,'task-a');assert.equal(finished.payments[0].archiveId,'j_11');
 const older=workProgress(messages({workProgress:finished},step('old',{operation:'transact',input:JSON.stringify(input)},pending)));
 assert.deepEqual(older.payments,finished.payments);
});

test('unknown transport outcome keeps original payment identity and cannot masquerade as confirmed',()=>{
 const prior=workProgress(messages({},step('done',{operation:'status',input:JSON.stringify({id})},confirmed)));
 const failed=workProgress(messages({workProgress:prior},step('fail',{operation:'status',input:JSON.stringify({id})},{error:'work_wallet_custody_unavailable',outcome:'unknown',next:'Read original action',archiveId:'j_12'})));
 assert.equal(failed.payments[0].status,'unknown');assert.equal(failed.payments[0].transactionHash,hash);assert.equal(failed.payments[0].id,id);assert.equal(failed.payments[0].outcome,'unknown');
 assert.equal(toolOutcome(pending).success,false);assert.equal(toolOutcome({outcome:'unknown'}).success,false);
});

test('schemas and unrelated results never create payments; payment history is bounded without changing messages',()=>{
 const steps=step('schema',{operation:'status',describe:true},confirmed);
 assert.equal(workProgress(messages({},steps)).payments.length,0);
 const many=Array.from({length:15},(_,n)=>step('p'+n,{operation:'transact',input:JSON.stringify(input)},{...pending,id:'ww_'+n.toString(16).padStart(64,'0'),archiveId:'j_'+(30+n)})).flat();
 const before=JSON.stringify(many);assert.equal(workProgress(messages({},many)).payments.length,12);assert.equal(JSON.stringify(many),before);
});

test('wallet reads stay fresh complete exchanges; projection does not deduplicate them or alter raw journal results',()=>{
 const value={address,chainId:1,balanceWei:'900',policy:{chainId:1,address},account:{active_id:id},actions:[confirmed]};
 const steps=[...step('a',{operation:'status'},value),...step('b',{operation:'status'},value)];
 const old=JSON.stringify(steps);const view=conversationWindow(steps,[],()=>true);assert.equal(view.length,4);assert.equal(JSON.stringify(steps),old);assert.equal(JSON.parse(view[1].content).contextProjection,'work-wallet-overview');
});
