import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';
import {reconcileQueuedGas} from '../adapters/chain-executor.mjs';

test('queue preparation retains gas before finality and settles only the canonical receipt', async t => {
  const store=openStore(':memory:');t.after(()=>store.close());
  const id='queue:approved',hash='0x'+'11'.repeat(32),blockHash='0x'+'22'.repeat(32);
  await store.transaction(tx=>tx.write('chain-transactions',id,{hash,gas:'100000',maxFeePerGas:'100',
    state:'confirmed',receipt:{blockNumber:'100',blockHash}},0));
  let final=98n,canonical=blockHash,settled=null,reads=0;
  const client={getBlock:async q=>q.blockTag?{number:final}:{hash:canonical},getTransactionReceipt:async()=>{
    reads++;return{transactionHash:hash,blockHash,blockNumber:100n,gasUsed:80000n,effectiveGasPrice:75n};}};
  const admission={finalizeGas:async(_tx,result)=>{settled=result;}};
  assert.deepEqual(await reconcileQueuedGas({store,client,admission,id}),{canonical:true,finalized:false});
  assert.equal(settled,null);assert.equal(reads,0);
  canonical='0x'+'33'.repeat(32);final=110n;
  assert.deepEqual(await reconcileQueuedGas({store,client,admission,id}),{canonical:false,finalized:false});
  assert.equal(settled,null);assert.equal(reads,0);
  canonical=blockHash;
  assert.deepEqual(await reconcileQueuedGas({store,client,admission,id}),{canonical:true,finalized:true});
  assert.deepEqual(settled,{id,actual:'6000000'});
  settled=null;client.getTransactionReceipt=async()=>({transactionHash:hash,blockHash,blockNumber:100n,gasUsed:100001n,effectiveGasPrice:75n});
  await assert.rejects(reconcileQueuedGas({store,client,admission,id}),{code:'transaction_receipt_mismatch'});
  assert.equal(settled,null);
});
