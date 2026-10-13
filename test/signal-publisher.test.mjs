import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeFunctionData,keccak256,parseTransaction} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {openStore} from '../src/storage/index.mjs';
import {digest} from '../src/shared/index.mjs';
import {signalAbi} from '../adapters/signal-read.mjs';
import {createSealer} from '../adapters/secrets.mjs';
import {admitSignalPublisherBudget,createSignalPublisher} from '../adapters/signal-publisher.mjs';

test('unknown publisher broadcast reconciles under its original finite budget after source withdrawal',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());const signer=privateKeyToAccount(generatePrivateKey()),now=1800000000000;
 const code='0x6000',address='0x'+'11'.repeat(20),grantId='0x'+'22'.repeat(32);
 const sourceResult={id:'public-result',revision:1,outputHash:digest('out')};
 const input={grantId,sequence:1,expectedVersion:1,observedAt:now/1000,validUntil:now/1000+3600,sourceResult,data:'0x1234'};
 const sourceHash='0x'+digest(sourceResult).slice(7);
 const operation={id:'op',projectId:'p',actor:'agent',kind:'record',input,transaction:{chainId:1,from:signer.address.toLowerCase(),to:address,value:'0',
  data:encodeFunctionData({abi:signalAbi,functionName:'publish',args:[grantId,1,1,input.observedAt,input.validUntil,sourceHash,input.data]})}};
 const budget={id:'finite',chainId:1,projectId:'p',store:address,storeCodeHash:keccak256(code),publisher:signer.address.toLowerCase(),grantId,
  expiresAt:now+86400000,maximumTransactions:1,maximumTotalWei:'200000000000',maximumTransactionWei:'200000000000',maximumGas:'1000000',maximumFeePerGas:'1000000'};
 await admitSignalPublisherBudget(store,budget);await store.transaction(tx=>tx.write('signal-operations',operation.id,operation,0));
 let confirmed=false,broadcasts=0,sent,hash;
 const client={getChainId:async()=>1,getCode:async()=>code,estimateGas:async()=>100000n,
  estimateFeesPerGas:async()=>({maxFeePerGas:1000000n,maxPriorityFeePerGas:0n}),getBalance:async()=>1000000000000000000n,getTransactionCount:async()=>0,
  sendRawTransaction:async({serializedTransaction})=>{broadcasts++;sent=parseTransaction(serializedTransaction);hash=keccak256(serializedTransaction);throw Error('lost response');},
  getTransactionReceipt:async()=>{if(!confirmed)throw Error('pending');return {transactionHash:hash,blockNumber:100n,blockHash:'0x'+'33'.repeat(32),status:'success',gasUsed:90000n,effectiveGasPrice:1000000n};},
  getBlockNumber:async()=>103n,getBlock:async()=>({number:103n,hash:'0x'+'33'.repeat(32)}),
  getTransaction:async()=>({...sent,from:signer.address,input:sent.data,value:0n})};
 let source=true;
 const make=()=>createSignalPublisher({store,client,signer,sealer:createSealer('11'.repeat(32)),budget,now:()=>now,
  identity:{authorize:async()=>{}},signals:{admission:async()=>true},services:{publicResult:async()=>{assert(source);return {...sourceResult,output:{onchainData:input.data}};}}});
 assert.equal((await make().step(operation)).state,'pending');
 assert.equal((await store.read('signal-publisher-budgets',budget.id)).value.reserved,'135000000000');
 source=false;confirmed=true;
 assert.equal((await make().step(operation)).state,'confirmed');
 const ledger=(await store.read('signal-publisher-budgets',budget.id)).value;
 assert.equal(ledger.reserved,'0');assert.equal(ledger.spent,'90000000000');assert.equal(ledger.transactions,1);assert.equal(broadcasts,1);
 await assert.rejects(admitSignalPublisherBudget(store,{...budget,maximumTransactions:2}),{code:'idempotency_conflict'});
 await assert.rejects(make().step({...operation,transaction:{...operation.transaction,to:'0x'+'44'.repeat(20)}}),{code:'signal_operation_mismatch'});
});
