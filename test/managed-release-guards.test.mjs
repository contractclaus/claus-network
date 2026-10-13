import test from 'node:test';import assert from 'node:assert/strict';
import {keccak256,parseTransaction} from 'viem';import{privateKeyToAccount}from'viem/accounts';
import{openStore}from'../src/storage/index.mjs';import{digest}from'../src/shared/index.mjs';
import{createSealer}from'../adapters/secrets.mjs';import{createChainExecutor}from'../adapters/chain-executor.mjs';
import{createClausController}from'../adapters/claus-controller.mjs';
const addr=n=>'0x'+String(n).repeat(40),word='0x'+'12'.repeat(32),profile='claus-managed-v1';

test('managed Sepolia deployment stays pending until finalized without rebroadcast or duplicate spending',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());const signer=privateKeyToAccount('0x'+'11'.repeat(32));
 const projectId='prj_local',cap={enabled:true,profile,chainId:11155111,executor:addr(2),executorCodeHash:word,approvalSigner:addr(3),executorPayer:signer.address,artifactProjectId:'prj_kernel',targetArtifactHash:digest('target')};
 await store.transaction(async tx=>{await tx.write('network-capabilities','chain:11155111:managed',cap,0);await tx.write('review-cases','case',{projectId,state:'reviewed',input:{sourceHash:word}},0);await tx.write('public-sources',digest({projectId,id:word}),{published:true},0);});
 let raw,final=99n,broadcasts=0,reserves=0,settlements=0,verifications=0;
 const client={getChainId:async()=>11155111,estimateGas:async()=>100000n,estimateFeesPerGas:async()=>({maxFeePerGas:1000000n,maxPriorityFeePerGas:0n}),getTransactionCount:async()=>0,getBalance:async()=>10n**16n,
  sendRawTransaction:async x=>{raw=x.serializedTransaction;broadcasts++;return keccak256(raw);},getBlockNumber:async()=>110n,
  getBlock:async x=>({number:x.blockTag==='finalized'?final:x.blockNumber,hash:word}),getCode:async()=>'0x6000',
  getTransactionReceipt:async()=>({transactionHash:keccak256(raw),blockNumber:100n,blockHash:word,contractAddress:addr(4),status:'success',gasUsed:90000n,effectiveGasPrice:1000000n}),
  getTransaction:async()=>({...parseTransaction(raw),from:signer.address,input:parseTransaction(raw).data,value:0n})};
 const executor=createChainExecutor({store,client,signer,sealer:createSealer('12'.repeat(32)),profile,chain:{capabilityMatches:async()=>{},validateModule:()=>{}},verification:{step:async()=>{verifications++;return{state:'verified'};}},
  admission:{reserveGas:async()=>{reserves++;},finalizeGas:async()=>{settlements++;}},now:()=>1800000000000});
 const input={kind:'module-deploy',value:{id:'local-module',projectId,profile,chainId:11155111,caseId:'case',expiresAt:1800000100000},artifact:{creationBytecode:'0x6000',runtimeTemplateHash:keccak256('0x6000')},authorize:async()=>true};
 assert.equal((await executor.deployment.step(input)).state,'deploying');assert.equal(settlements,0);assert.equal(verifications,0);
 final=100n;assert.equal((await executor.deployment.step(input)).state,'verified');assert.equal(broadcasts,1);assert.equal(reserves,1);assert.equal(settlements,1);assert.equal(verifications,1);
});

test('controller will not sign an approval with only a retry-sized execution window left',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());const signer=privateKeyToAccount('0x'+'22'.repeat(32));let signed=0;
 const now=1800000000,delay=432000,proposal={profile,chainId:11155111,executor:addr(2),expiresAt:now+delay+900},projectId='prj_delay',reviewHash=digest('review');
 const value={id:'local-delay',projectId,proposal,proposalHash:digest(proposal),reviewArtifactHash:reviewHash};
 const input={projectId,proposal,proposalHash:value.proposalHash,review:{artifactHash:reviewHash}};
 const result={inputHash:digest(input),proposalHash:value.proposalHash,reviewArtifactHash:reviewHash,decision:'approve'};result.decisionHash=digest(result);
 await store.transaction(async tx=>{await tx.write('chain-bindings',projectId,{local:true},0);await tx.write('network-capabilities','chain:11155111:managed',{enabled:true,profile,chainId:11155111,executor:proposal.executor,approvalSigner:signer.address},0);});
 const controller=createClausController({store,profile,signer:{...signer,signTypedData:async()=>{signed++;throw Error('must not sign');}},secret:'local',now:()=>now*1000,client:{},chain:{capabilityMatches:async()=>{},validateProposal:async()=>({minDelaySeconds:delay})},fetcher:async()=>Response.json({id:'nr_'+digest(input).slice(7),state:'completed',result})});
 await assert.rejects(controller.step({value,input,authorize:async()=>true}),{code:'proposal_expiring'});assert.equal(signed,0);assert.equal(await store.read('claus-signed-approvals',value.id),null);
});
