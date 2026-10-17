import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';
import {balance} from '../src/billing/index.mjs';
import {digest} from '../src/shared/index.mjs';
import {createFundingReconciler} from '../src/infrastructure/funding.mjs';
import {infrastructureCycle} from '../runtime/infrastructure-cycle.mjs';

async function fixture(t){
 const store=openStore(':memory:');t.after(()=>store.close());let at=2_000_000;
 const original={id:'initial',amount:'50000000',completedAt:100,type:'RELOAD',medium:'STRIPE'};
 const reload={id:'new',amount:'100000000',completedAt:1000,type:'RELOAD',medium:'STRIPE'};
 let receipts=[original,reload],providerAccountId='provider',hook=async()=>{};
 await store.transaction(async tx=>{
  await tx.write('balances',digest({account:'fund',asset:'USD'}),{account:'fund',asset:'USD',available:'48000000',reserved:'1500000',spent:'500000'},0);
  await tx.write('infrastructure-funding','runpod',{enabled:true,profileId:'cpu',accountId:'runpod',providerAccountId:'provider',fundingAccount:'fund',fundedTotal:'50000000',startedAt:0,through:0,nextAt:0,followProfiles:['cpu']},0);
  await tx.write('infrastructure-funding-receipts',digest({provider:'runpod',providerAccountId:'provider',transactionId:'initial'}),{hash:digest(original),fundingAccount:'fund',receiptId:'original-operator-receipt'},0);
  await tx.write('infrastructure-controls','cpu',{enabled:true,expiresAt:null,pooledFunding:true,providerFundingId:'runpod',fundingAccount:'fund',totalLimit:'50000000',perProjectLimit:'50000000',dailyLimit:'50000000',allocated:'160000000'},0);
  await tx.write('network-capabilities','continuous-operation',{enabled:true,profile:'claus-operation-v1',expiresAt:null},0);
  await tx.write('network','authority',{ownerAddress:'0xowner'},0);
  await tx.write('principals','owner',{chainId:1,address:'0xowner'},0);
  for(const [id,ownerId,enabled,limit]of [['own','owner',true,'50000000'],['limited','owner',true,'10000000'],['revoked','owner',false,'50000000'],['foreign','foreign',true,'50000000']]){
   await tx.write('projects',id,{ownerId},0);await tx.write('infrastructure-grants',id,{profileId:'cpu',projectId:id,enabled,expiresAt:null,limit,reserved:'1000',spent:'2000'},0);
  }
 });
 const sync=createFundingReconciler({store,now:()=>at,ports:{fundingHistory:async input=>{await hook();return {...input,provider:'runpod',accountId:'runpod',providerAccountId,observedAt:at,balanceMicroUsd:'148000000',receipts};}}});
 return{store,sync,reload,original,advance:()=>at+=360000,setReceipts:v=>receipts=v,setAccount:v=>providerAccountId=v,setHook:f=>hook=f};
}
test('confirmed reload credits once; existing deposit and unknown reservations remain intact',async t=>{
 const f=await fixture(t);assert.equal((await f.sync()).added,'100000000');f.advance();assert.equal((await f.sync()).added,'0');
 assert.deepEqual(await balance(f.store,'fund','USD'),{account:'fund',asset:'USD',available:'148000000',reserved:'1500000',spent:'500000'});
 assert.equal((await f.store.read('infrastructure-grants','own')).value.limit,'150000000');
 for(const id of ['foreign','revoked'])assert.equal((await f.store.read('infrastructure-grants',id)).value.limit,'50000000');
 assert.equal((await f.store.read('infrastructure-grants','limited')).value.limit,'10000000');
 assert.equal((await f.store.read('infrastructure-controls','cpu')).value.allocated,'260000000');
 assert.equal((await f.store.list('funding-receipts')).length,1);
});
test('changed receipt rolls back the entire batch, including a preceding new payment',async t=>{
 const f=await fixture(t);f.setReceipts([f.reload,{...f.original,amount:'90000000'}]);
 await assert.rejects(f.sync(),{code:'infrastructure_funding_receipt_conflict'});
 assert.equal((await balance(f.store,'fund','USD')).available,'48000000');assert.equal((await f.store.list('funding-receipts')).length,0);
});
test('other provider account and revocation during a read cannot create money',async t=>{
 const f=await fixture(t);f.setAccount('foreign');await assert.rejects(f.sync(),{code:'infrastructure_funding_account_mismatch'});
 f.setAccount('provider');f.setHook(()=>f.store.transaction(async tx=>{const r=await tx.read('infrastructure-funding','runpod');await tx.write('infrastructure-funding','runpod',{...r.value,enabled:false},r.revision);}));
 await assert.rejects(f.sync(),{code:'infrastructure_funding_changed'});assert.equal((await balance(f.store,'fund','USD')).available,'48000000');
});
test('funding outage does not prevent existing resource maintenance and stop reconciliation',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());let ticks=0;
 const result=await infrastructureCycle({store,infrastructure:{discovery:async()=>({reconciliation:true}),reconcileFunding:async()=>{throw Error('provider unavailable');},tick:async()=>{ticks++;return{processed:1,nextCursor:null};}}});
 assert.equal(ticks,1);assert.equal(result.state,'observed');assert.equal(result.funding.state,'unavailable');
});
