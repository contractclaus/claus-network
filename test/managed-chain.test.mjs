import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compileSnapshot } from '../adapters/compiler.mjs';
import { createChainRead } from '../adapters/chain-read.mjs';
import { digest } from '../src/shared/index.mjs';

const word='0x'+'12'.repeat(32),zero='0x'+'00'.repeat(32),empty='0x'+'00'.repeat(20);
const address=n=>'0x'+String(n).repeat(40);

test('managed registration, activation evidence and upgrades retain exact source and profile bindings', async()=>{
 const owner=privateKeyToAccount('0x'+'11'.repeat(32));
 const path='reference/managed-counter/Counter.sol',content=await readFile(new URL('../'+path,import.meta.url),'utf8');
 const build=await compileSnapshot({files:[{path,content}],entry:path,contract:'Counter',compilerProfile:'solidity-managed-compile-v1'});
 const registry=address(2),target=address(3),impl=address(4),registryCode='0x6001',targetCode='0x6002';
 let version=0,config='0x',delay=0n;
 const module={id:'module',profile:'claus-managed-v1',chainId:1,state:'verified',address:impl,codeHash:build.runtimeTemplateHash};
 const capability={profile:module.profile,chainId:1,enabled:true,executor:registry,executorCodeHash:keccak256(registryCode)};
 const binding={profile:module.profile,chainId:1,owner:owner.address,executor:registry,target,codeHash:keccak256(targetCode),projectKey:word};
 const client={getChainId:async()=>1,getBlockNumber:async()=>50n,getBlock:async()=>({number:50n,hash:word,timestamp:1800000000n}),
  getStorageAt:async()=>zero,getCode:async({address})=>address===registry?registryCode:address===target?targetCode:build.runtimeTemplate,
  readContract:async({functionName})=>{
   const values={MIN_UPGRADE_DELAY:0n,projects:[owner.address,target,word,word,delay,1n,1n,true],
    version:BigInt(version),implementation:version?impl:empty,implementationCodeHash:version?build.runtimeTemplateHash:zero,
    clausGeneration:1n,pendingSigner:empty,pendingProjectOwners:empty,executor:registry,projectId:word,
    moduleState:[version?impl:empty,version?build.runtimeTemplateHash:zero,BigInt(version),config],
    initialModules:[impl,build.runtimeTemplateHash,keccak256('0x'),49n]};
   assert.ok(Object.hasOwn(values,functionName),functionName);return values[functionName];
  }};
 const chain=createChainRead({client,chainId:1,profile:module.profile});
 const registration=await chain.registration({projectId:'prj_counter',owner:owner.address,module,configuration:'0x',mandateHash:word,minDelaySeconds:0,capability,expiresAt:1800000300});
 assert.equal(registration.domain.name,'Claus Managed Network');
 const signature=await owner.signTypedData(registration);
 assert.equal(await chain.verifyRegistration(registration,signature),true);
 await assert.rejects(createChainRead({client,chainId:1}).verifyRegistration(registration,signature),{code:'registration_profile_mismatch'});
 const snapshot=await chain.captureEvidence({module,binding,capability});
 const proposal=await chain.proposal({binding,module,configuration:'0x',dependencySnapshot:snapshot,nonceSeed:'first',now:1800000000});
 assert.equal(proposal.fromVersion,0);assert.equal(snapshot.managed.previous,null);
 await chain.validateProposal(proposal,binding,snapshot);
 await assert.rejects(chain.proposal({binding,module,configuration:'0x01',dependencySnapshot:snapshot,nonceSeed:'bad',now:1800000000}),{code:'managed_initial_mismatch'});
 version=1;
 await assert.rejects(chain.captureEvidence({module,binding,capability}),{code:'managed_previous_source_missing'});
 const source={buildHash:digest(build),snapshotHash:digest([{path,hash:digest({path,content})}]),entry:path,files:[{path,content}],repository:'https://github.com/contractclaus/claus-network',commit:'a'.repeat(40)};
 const upgrade=await chain.captureEvidence({module,binding,capability,previous:{build,source}});
 assert.equal(upgrade.managed.previous.codeHash,build.runtimeTemplateHash);
 const next=await chain.proposal({binding,module,configuration:'0x',dependencySnapshot:upgrade,nonceSeed:'next',now:1800000000});
 assert.equal(next.fromVersion,1);await chain.validateProposal(next,binding,upgrade);
 // The review and queue budget must not shrink as the owner delay increases.
 for(const seconds of [0,79200,86400,432000]){
  delay=BigInt(seconds);
  const delayed=await chain.proposal({binding,module,configuration:'0x',dependencySnapshot:upgrade,nonceSeed:'delayed-'+seconds,now:1800000000});
  const readyAfterTwoHourReview=1800000000+7200+seconds;
  assert.equal(delayed.expiresAt-readyAfterTwoHourReview,79200);
 }
});
