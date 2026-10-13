import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createPublicClient,createWalletClient,http,keccak256,encodeAbiParameters,stringToHex} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {createSignalRead,signalAbi} from '../adapters/signal-read.mjs';
import {createChainRead,domain,approvalMessage,approvalTypes} from '../adapters/chain-read.mjs';
import {captureSignalConsumer,validateSignalRuntime} from '../adapters/signal-evidence.mjs';
import {digest} from '../src/shared/index.mjs';
import {openStore} from '../src/storage/index.mjs';
import {createSignals} from '../src/signals/index.mjs';

test('real local signal lifecycle binds source, typed grant, reviewed consumer, version, finalized receipts and revocation',
 {skip:!process.env.CLAUS_TEST_CHAIN||!process.env.CLAUS_SIGNAL_BUILDS,timeout:60000},async t=>{
 const url=new URL(process.env.CLAUS_TEST_CHAIN);assert.equal(url.hostname,'127.0.0.1');
 const client=createPublicClient({transport:http(url.href,{retryCount:0}),cacheTime:0,pollingInterval:50});assert.equal(await client.getChainId(),1);
 const [owner,claus,publisher]=Array.from({length:3},()=>privateKeyToAccount(generatePrivateKey()));
 for(const a of [owner,publisher])await client.request({method:'anvil_setBalance',params:[a.address,'0x56bc75e2d63100000']});
 const wallet=a=>createWalletClient({account:a,transport:http(url.href)});
 const wait=async hash=>{const r=await client.waitForTransactionReceipt({hash});assert.equal(r.status,'success');return r;};
 const send=async(tx,signer=owner)=>{assert.equal(tx.from,signer.address.toLowerCase());return wait(await wallet(signer).sendTransaction({chain:null,to:tx.to,data:tx.data,value:0n}));};
 const final=()=>client.request({method:'anvil_mine',params:['0x60','0x1']});
 const artifact=async name=>(JSON.parse(await readFile(process.env.CLAUS_SIGNAL_BUILDS+'/'+name+'.json'))).artifact;
 const [build,factoryBuild,pulse]=await Promise.all(['ClausSignalStore','ClausSignalFactory','ClausPulseModule'].map(artifact));
 const native=JSON.parse(await readFile(new URL('../contracts/out/ClausApprovalExecutor.sol/ClausApprovalExecutor.json',import.meta.url)));
 const deploy=async(abi,bytecode,args)=>(await wait(await wallet(owner).deployContract({chain:null,abi,bytecode,args}))).contractAddress;
 const executor=await deploy(native.abi,native.bytecode.object,[claus.address,owner.address,86400n]);
 const moduleAddress=await deploy(pulse.abi,pulse.creationBytecode,[]);
 const chain=createChainRead({client,chainId:1}), signalChain=createSignalRead({client,chainId:1});
 const now=()=>client.getBlock({blockTag:'latest'});
 const configData=encodeAbiParameters([{type:'uint256'},{type:'uint256'}],[1000000000n,3600n]);
 const module={id:'fixture',state:'verified',chainId:1,address:moduleAddress,codeHash:keccak256(await client.getCode({address:moduleAddress}))};
 const capability={enabled:true,chainId:1,profile:'claus-readonly-v1',executor,executorCodeHash:keccak256(await client.getCode({address:executor}))};
 const registration=await chain.registration({projectId:'prj_signal-local',owner:owner.address,module,configuration:configData,
  mandateHash:keccak256(stringToHex('local-grant')),minDelaySeconds:0,capability,expiresAt:Number((await now()).timestamp)+86400});
 const signature=await owner.signTypedData(registration);
 await wait(await wallet(owner).writeContract({chain:null,address:executor,abi:native.abi,functionName:'registerProject',args:[registration.message,configData,signature]}));
 const p=await client.readContract({address:executor,abi:native.abi,functionName:'projects',args:[registration.message.projectId]});
 const binding={projectKey:registration.message.projectId,target:p[1],owner:owner.address,chainId:1,executor,profile:'claus-readonly-v1'};
 const factory=await deploy(factoryBuild.abi,factoryBuild.creationBytecode,[executor]);
 const config={chainId:1,executor,factory,factoryCodeHash:keccak256(await client.getCode({address:factory})),
  factoryArtifactHash:digest(factoryBuild),feedId:keccak256(stringToHex('claus.network-pulse.v1')),
  schemaHash:keccak256(stringToHex('Pulse(uint64 blockNumber,bytes32 blockHash,uint256 baseFeeWei,bool aboveThreshold)'))};
 await signalChain.validateAdmission(config,factoryBuild);
 const prepared=await signalChain.prepareStore(config,binding),receipt=await send(prepared.transaction);
 await final();const recovered=await signalChain.prepareStore(config,binding);assert.equal(recovered.recovered,true);
 const observed=await signalChain.observe({...prepared,kind:'store',config,binding},receipt.transactionHash);
 assert.equal(observed.state,'confirmed');
 await signalChain.validateStoreBuild({...config,storeArtifactHash:digest(build)},observed.signal,build,factoryBuild,observed.blockNumber);
 const signal={...observed.signal,projectId:'prj_signal-local',state:'verified',profile:'claus-signal-v1',artifactHash:digest(build),config};
 const report={complete:true,jobId:'local-fixture-only',report:'Explicit local fixture; not an independent live review or approval.'};signal.reviewArtifactHash=digest(report);
 const consumer={signal,build,factoryBuild,review:report};
 const captured=await captureSignalConsumer({client,consumer,blockNumber:(await client.getBlock({blockTag:'finalized'})).number});
 assert.equal(captured.store.address,signal.address);
 assert.throws(()=>validateSignalRuntime({build,buildHash:digest(build),factoryBuild,factoryBuildHash:digest(factoryBuild),executor,
  storeCode:captured.store.code.slice(0,-2)+'00',factoryCode:captured.factory.code}),{code:'signal_evidence_invalid'});
 const terms={publisher:publisher.address,maximumWrites:3,minimumInterval:1,expiresAt:Number((await now()).timestamp)+86400,nonce:'14'};
 const grantHead=Number((await now()).timestamp);
 for(const expiresAt of [grantHead+1,grantHead+30*86400+1])await assert.rejects(signalChain.prepareGrant(signal,binding,{...terms,expiresAt}),{code:'signal_grant_expiry'});
 // Exercise the actual API/chain-adapter composition: an unregistered grant
 // reads as not-found, while a revoked unregistered digest has real state.
 const apiStore=openStore(':memory:');t.after(()=>apiStore.close());
 Object.assign(config,{enabled:true,profile:'claus-signal-v1',expiresAt:(grantHead+86400)*1000,
  artifactProjectId:'local-review',reviewCaseId:'local-review',reviewArtifactHash:digest(report),storeArtifactHash:digest(build)});
 await apiStore.transaction(async tx=>{
  await tx.write('chain-bindings',signal.projectId,binding,0);await tx.write('project-signals',signal.projectId,signal,0);
  await tx.write('network-capabilities','signal:1',config,0);
  await tx.write('review-cases','local-review',{state:'reviewed',projectId:'local-review',artifactHash:digest(report)},0);
  await tx.write('signal-admission-assessments',digest(config),{accepted:true,profileHash:digest(config),reviewArtifactHash:digest(report),
   factoryArtifactHash:digest(factoryBuild),storeArtifactHash:digest(build)},0);
 });
 const api=createSignals({store:apiStore,chain:signalChain,identity:{authorize:async()=>{}},
  artifacts:{get:async(_p,h)=>h===digest(factoryBuild)?factoryBuild:build},now:()=>grantHead*1000});
 const grant=await api.grantPrepare('owner',signal.projectId,{...terms,idempotencyKey:'local-grant'});
 await assert.rejects(signalChain.grant(signal,grant.grantId),{code:'signal_grant_not_found'});
 await assert.rejects(api.grantRegister('owner',signal.projectId,{operationId:grant.id,signature:await publisher.signTypedData(grant.typedData)}),{code:'invalid_signature'});
 const registered=await api.grantRegister('owner',signal.projectId,{operationId:grant.id,signature:await owner.signTypedData(grant.typedData)});
 const preRevoked=await api.grantPrepare('owner',signal.projectId,{...terms,nonce:'15',idempotencyKey:'local-pre-revoked'});
 await send((await signalChain.prepareRevoke(signal,binding,preRevoked.grantId)).transaction);await final();
 await assert.rejects(api.grantRegister('owner',signal.projectId,{operationId:preRevoked.id,signature:await owner.signTypedData(preRevoked.typedData)}),{code:'signal_grant_inactive'});
 await send(registered.transaction,publisher);await final();
 assert.equal((await signalChain.grant(signal,grant.grantId)).terms.nonce,'14');
 const record=async(sequence,version)=>{const block=await now();return {grantId:grant.grantId,sequence,expectedVersion:version,
  observedAt:Number(block.timestamp),validUntil:Number(block.timestamp)+600,sourceHash:keccak256(stringToHex('public-result-fixture')),
  data:encodeAbiParameters([{type:'uint256'},{type:'uint64'},{type:'bytes32'},{type:'uint64'},{type:'uint256'}],
   [1n,block.number,block.hash,block.timestamp,2000000000n])};};
 const expiring=await record(1,1);expiring.validUntil=expiring.observedAt+1;
 await assert.rejects(signalChain.prepareRecord(signal,binding,expiring),{code:'signal_data_expired'});
 const first=await signalChain.prepareRecord(signal,binding,await record(1,1));await send(first.transaction,publisher);
 await final();const current=await signalChain.latest(signal);assert.equal(current.record.sequence,'1');assert.equal(current.authorizationActive,true);assert.equal(current.currentVersion,1);
 const snapshot=await chain.captureEvidence({module,consumer});
 const proposal=await chain.proposal({binding,module,configuration:encodeAbiParameters([{type:'uint256'},{type:'uint256'}],[3000000000n,3600n]),
  dependencySnapshot:snapshot,nonceSeed:'local-reviewed-config',now:Number((await now()).timestamp)});
 const evidenceHash=keccak256(stringToHex('local test decision; not Claus live'));
 const approval=approvalMessage(proposal,evidenceHash),sig=await claus.signTypedData({domain:domain(executor,1),types:approvalTypes,primaryType:'Approval',message:approval});
 await wait(await wallet(owner).writeContract({chain:null,address:executor,abi:native.abi,functionName:'queue',args:[approval,sig]}));
 await wait(await wallet(owner).writeContract({chain:null,address:executor,abi:native.abi,functionName:'execute',args:[approval,proposal.configuration,sig]}));
 await assert.rejects(signalChain.prepareRecord(signal,binding,await record(2,1)),{code:'signal_stale_version'});
 await send((await signalChain.prepareRecord(signal,binding,await record(2,2))).transaction,publisher);
 await send((await signalChain.prepareRevoke(signal,binding,grant.grantId)).transaction);
 await assert.rejects(signalChain.prepareRecord(signal,binding,await record(3,2)),{code:'signal_grant_inactive'});
 await final();const latest=await signalChain.latest(signal);assert.equal(latest.record.sequence,'2');assert.equal(latest.record.version,'2');assert.equal(latest.authorizationActive,false);assert.equal((await signalChain.grant(signal,grant.grantId)).finalized,true);
 if(process.env.CLAUS_SIGNAL_FIXTURE)await writeFile(process.env.CLAUS_SIGNAL_FIXTURE,JSON.stringify({consumer:snapshot.consumer,proposal,projectId:'prj_signal-local'})+'\n');
});
