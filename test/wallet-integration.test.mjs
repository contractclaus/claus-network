import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPublicClient, createWalletClient, http, keccak256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createApplication, listen } from '../runtime/server.mjs';
import { createClient } from '../interfaces/sdk.mjs';
import { createWalletRead } from '../adapters/wallet-read.mjs';
import { createWalletExecutor } from '../adapters/wallet-executor.mjs';
import { createServiceConformance } from '../runtime/service-conformance.mjs';
import { createSealer } from '../adapters/secrets.mjs';
import { openStore } from '../src/storage/index.mjs';

test('external clients deploy an owner wallet, delegate bounded payments, pay a provider and revoke without website',
 {skip:!process.env.CLAUS_TEST_WALLET_CHAIN,timeout:90000},async t=>{
  const url=new URL(process.env.CLAUS_TEST_WALLET_CHAIN);assert.equal(url.hostname,'127.0.0.1');
  const chainClient=createPublicClient({transport:http(url.href,{retryCount:0}),cacheTime:0});
  assert.equal(await chainClient.getChainId(),11155111);
  await chainClient.request({method:'anvil_reset',params:[]});
  let time=Number((await chainClient.getBlock()).timestamp)*1000;
  const now=()=>time,store=openStore(':memory:');t.after(()=>store.close());
  const walletChain=createWalletRead({client:chainClient,now});
  const app=createApplication({store,now,rateSalt:'local-test-only'.repeat(4),chainPorts:{client:chainClient,wallet:walletChain}});
  const server=await listen(app);t.after(()=>new Promise(r=>server.close(r)));
  const origin='http://127.0.0.1:'+server.address().port,guest=createClient({origin});
  const gasPayer=privateKeyToAccount(generatePrivateKey()),sessionSigner=privateKeyToAccount(generatePrivateKey());
  await chainClient.request({method:'anvil_setBalance',params:[gasPayer.address,'0x56bc75e2d63100000']});
  async function project(name){
    const key=privateKeyToAccount(generatePrivateKey());
    await chainClient.request({method:'anvil_setBalance',params:[key.address,'0x56bc75e2d63100000']});
    const c=await guest.call('auth_challenge',{address:key.address});
    const auth=await guest.call('auth_session',{challengeId:c.id,signature:await key.signMessage({message:c.message})});
    const owner=createClient({origin,token:auth.token});
    const p=await owner.call('project_create',{slug:name,name,idempotencyKey:name});
    const a=await owner.call('agent_create',{projectId:p.id,name:'Provider client'});
    const m=await owner.call('mandate_create',{projectId:p.id,principalId:a.id,expiresAt:time+86400000,
      scopes:['project.read','project.publish','service.manage','service.read','service.call','service.provide','wallet.read','wallet.manage','wallet.pay','job.cancel']});
    const credential=await owner.call('credential_create',{mandateId:m.id});
    return {key,owner,mandate:m,id:p.id,client:createClient({origin,token:credential.token})};
  }
  const provider=await project('wallet-provider'),buyer=await project('wallet-buyer');
  await store.transaction(async tx=>{
    await tx.write('network-capabilities','collaboration',{enabled:true},0);
    await tx.write('review-pilots',provider.id,{enabled:true,expiresAt:time+86400000},0);
    await tx.write('review-pilots',buyer.id,{enabled:true,expiresAt:time+86400000},0);
  });
  const schema={type:'object',properties:{value:{type:'string',maxLength:100}},required:['value'],additionalProperties:false};
  const version=await provider.client.call('service_register',{projectId:provider.id,manifest:{name:'Echo',capability:'test.echo',version:'1.0.0',
    inputSchema:schema,outputSchema:schema,priceWei:'1000',recipient:provider.key.address,maxDurationSeconds:600,validUntil:time+86400000,dataPolicy:'no-delegation'}});
  const conformance=createServiceConformance({store,services:app.services});await conformance.tick();
  const probe=(await provider.client.call('provider_orders',{projectId:provider.id})).orders[0];
  const claim=await provider.client.call('provider_claim',{projectId:provider.id,orderId:probe.id});
  await provider.client.call('provider_deliver',{projectId:provider.id,orderId:probe.id,lease:claim.lease,output:claim.input});await conformance.tick();
  await provider.client.call('service_publish',{projectId:provider.id,serviceId:version.id,published:true,expectedRevision:0});
  const contract=JSON.parse(await readFile(new URL('../contracts/out/ClausProjectWallet.sol/ClausProjectWallet.json',import.meta.url)));
  await store.transaction(async tx=>{
    const hash=await app.artifacts.put(tx,buyer.id,{contract:'ClausProjectWallet',creationBytecode:contract.bytecode.object});
    await tx.write('network-capabilities','wallets',{enabled:true,chainId:11155111,artifactProjectId:buyer.id,artifactHash:hash},0);
  });
  const executor=createWalletExecutor({store,client:chainClient,signer:gasPayer,chain:walletChain,artifacts:app.artifacts,
    sealer:createSealer('cd'.repeat(32)),now,verification:{step:async()=>({state:'verified',localFixture:true})}});
  async function advance(){await chainClient.request({method:'evm_increaseTime',params:[31]});
    await chainClient.request({method:'anvil_mine',params:['0x3','0x1']});time=Number((await chainClient.getBlock()).timestamp)*1000;}
  async function until(read,state){for(let i=0;i<8;i++){await app.wallets.runOne(executor);const x=await read();if(x.state===state)return x;
    if(['failed','blocked'].includes(x.state))assert.fail(JSON.stringify(x));await advance();}
    assert.fail(JSON.stringify({last:await read(),jobs:(await store.list('workflow-jobs')).map(x=>x.value.result)}));}
  const queued=await buyer.client.call('wallet_create',{projectId:buyer.id});assert.equal(queued.state,'queued');
  assert.equal((await buyer.client.call('wallet_create',{projectId:buyer.id})).actionId,queued.actionId);
  const cancelledAction=await buyer.client.call('wallet_action',{projectId:buyer.id,actionId:queued.actionId});
  await buyer.client.call('job_cancel',{projectId:buyer.id,jobId:cancelledAction.jobId});
  const retried=await buyer.client.call('wallet_create',{projectId:buyer.id});
  assert.notEqual(retried.actionId,queued.actionId);assert.equal(retried.attempt,2);
  const wallet=await until(()=>buyer.client.call('wallet_get',{projectId:buyer.id}),'verified');
  assert.equal(wallet.owner.toLowerCase(),buyer.key.address.toLowerCase());
  const buyerEvm=createWalletClient({account:buyer.key,transport:http(url.href)});
  await buyerEvm.sendTransaction({chain:null,to:wallet.address,value:10000n});
  const sessionId=keccak256('0x1234');
  const prepared=await buyer.client.call('wallet_session_prepare',{projectId:buyer.id,session:{sessionId,signer:sessionSigner.address,
    recipient:provider.key.address,perPayment:'1000',total:'2000',validUntil:Math.floor(time/1000)+86400}});
  await assert.rejects(provider.client.call('wallet_session_submit',{projectId:buyer.id,sessionId:prepared.id,
    signature:await buyer.key.signTypedData(prepared.typedData)}),{code:'scope_denied'});
  const sessionAction=await buyer.client.call('wallet_session_submit',{projectId:buyer.id,sessionId:prepared.id,
    signature:await buyer.key.signTypedData(prepared.typedData)});
  await until(()=>buyer.client.call('wallet_action',{projectId:buyer.id,actionId:sessionAction.id}),'confirmed');
  async function order(key){const q=await buyer.client.call('service_quote',{projectId:buyer.id,serviceId:version.id,input:{value:key},idempotencyKey:key});
    return buyer.client.call('service_accept',{projectId:buyer.id,quoteId:q.id});}
  const o=await order('paid-output'),payment=await buyer.client.call('wallet_payment_prepare',{projectId:buyer.id,orderId:o.id,sessionId});
  const tampered=structuredClone(payment.typedData);tampered.message.amount='1001';
  await assert.rejects(buyer.client.call('wallet_payment_submit',{projectId:buyer.id,paymentId:payment.id,
    signature:await sessionSigner.signTypedData(tampered)}),{code:'invalid_signature'});
  const signed=await sessionSigner.signTypedData(payment.typedData);
  const action=await buyer.client.call('wallet_payment_submit',{projectId:buyer.id,paymentId:payment.id,signature:signed});
  const confirmed=await until(()=>buyer.client.call('wallet_action',{projectId:buyer.id,actionId:action.id}),'confirmed');
  assert.equal((await buyer.client.call('service_order',{projectId:buyer.id,orderId:o.id})).payment.state,'confirmed');
  assert.equal((await buyer.client.call('wallet_payment_submit',{projectId:buyer.id,paymentId:payment.id,signature:signed})).id,action.id);
  assert.equal(await chainClient.getBalance({address:wallet.address}),9000n);
  const work=await provider.client.call('provider_claim',{projectId:provider.id,orderId:o.id});assert.equal(work.input.value,'paid-output');
  const done=await provider.client.call('provider_deliver',{projectId:provider.id,orderId:o.id,lease:work.lease,output:{value:'delivered'}});
  const accepted=await buyer.client.call('service_accept_result',{projectId:buyer.id,orderId:o.id,outputHash:done.outputHash,accepted:true});
  assert.equal(accepted.acceptance,'accepted');assert.ok(confirmed.receipt.blockHash);
  const revoke=await buyer.client.call('wallet_session_revoke',{projectId:buyer.id,sessionId});
  const revoked=await buyerEvm.sendTransaction({chain:null,to:revoke.to,data:revoke.data});
  await chainClient.waitForTransactionReceipt({hash:revoked});
  const next=await order('revoked');
  await assert.rejects(buyer.client.call('wallet_payment_prepare',{projectId:buyer.id,orderId:next.id,sessionId}),{code:'session_payment_denied'});
  await buyer.owner.call('mandate_revoke',{mandateId:buyer.mandate.id});
  await assert.rejects(buyer.client.call('wallet_get',{projectId:buyer.id}),{code:'scope_denied'});
  const recover=await buyerEvm.writeContract({chain:null,address:wallet.address,abi:contract.abi,functionName:'ownerCall',args:[buyer.key.address,9000n,'0x']});
  await chainClient.waitForTransactionReceipt({hash:recover});assert.equal(await chainClient.getBalance({address:wallet.address}),0n);
});
