import test from 'node:test';import assert from 'node:assert/strict';
import {finalizedReplacement} from '../adapters/transaction-replacement.mjs';
const sender='0x'+'12'.repeat(20),hash='original';
function fixture(){
 let seen='replacement',changed=false;
 return {set(hash){seen=hash;},change(){changed=true;},client:{
  getTransactionCount:async({blockNumber})=>blockNumber<50n?3:4,
  getBlock:async({blockNumber=100n,includeTransactions})=>({number:blockNumber,hash:changed&&!includeTransactions?'reorg':'block-'+blockNumber,
   transactions:includeTransactions?[{from:sender,nonce:3,hash:seen}]:[]}),
  getTransactionReceipt:async({hash})=>({transactionHash:hash,from:sender,blockNumber:50n,blockHash:'block-50'})
 }};
}
test('a finalized competing transaction proves the exact nonce was consumed, while the original cannot be misclassified',async()=>{
 const f=fixture();assert.equal((await finalizedReplacement(f.client,{sender,nonce:3,hash})).transactionHash,'replacement');
 f.set(hash);assert.equal(await finalizedReplacement(f.client,{sender,nonce:3,hash}),null);
 assert.equal(await finalizedReplacement(f.client,{sender,nonce:4,hash}),null);
 f.set('replacement');f.change();await assert.rejects(finalizedReplacement(f.client,{sender,nonce:3,hash}),{code:'replacement_evidence_changed'});
});
