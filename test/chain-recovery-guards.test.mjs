import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';
import {checkChainWorkerRoles} from '../runtime/chain-worker.mjs';
import {recoverChainEvent} from '../adapters/chain-event-recovery.mjs';

test('worker role mismatch is rejected even while admission is disabled',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());
 const approval='0x'+'11'.repeat(20),payer='0x'+'22'.repeat(20);
 await store.transaction(tx=>tx.write('network-capabilities','chain:1',{enabled:false,approvalSigner:approval,executorPayer:payer},0));
 await checkChainWorkerRoles(store,'executor',[[1,{address:payer}]]);
 await assert.rejects(checkChainWorkerRoles(store,'executor',[[1,{address:approval}]]),{code:'worker_role_mismatch'});
 await checkChainWorkerRoles(store,'controller',[[1,{address:approval}]]);
 await assert.rejects(checkChainWorkerRoles(store,'controller',[[1,{address:payer}]]),{code:'worker_role_mismatch'});
});

test('event recovery advances bounded finalized ranges without declaring an incomplete history empty',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());let calls=0,fail=false;
 const client={getBlock:async({blockNumber})=>({number:blockNumber??25000n,hash:'0x'+String(blockNumber??25000n)}),
  getLogs:async({fromBlock,toBlock})=>{calls++;assert(toBlock-fromBlock<10000n);if(fail)throw Error('RPC');return fromBlock<=23000n&&toBlock>=23000n?[{blockNumber:23000n}]:[];}};
 const input={store,client,chainId:1,key:'one-original-execution',query:{address:'executor'},fromBlock:500n};
 assert.equal((await recoverChainEvent(input)).complete,false);
 fail=true;await assert.rejects(recoverChainEvent(input));fail=false;
 assert.equal((await recoverChainEvent(input)).complete,false);
 const result=await recoverChainEvent(input);assert.equal(result.complete,true);assert.equal(result.logs[0].blockNumber,23000n);
 assert.equal(calls,4);assert.equal((await store.list('chain-event-recovery',{limit:10})).length,1);
});
