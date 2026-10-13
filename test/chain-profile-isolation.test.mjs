import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/storage/index.mjs';
import { chainProfile, projectProfile, MANAGED_PROFILE, READONLY_PROFILE } from '../src/chain-deployments/profiles.mjs';
import { createChainAdmission } from '../src/chain-deployments/admission.mjs';

test('legacy bindings and pending modules cannot be reinterpreted as managed', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  await store.transaction(async tx => {
    await tx.write('chain-bindings', 'legacy', { chainId: 1 }, 0);
    await tx.write('chain-modules', 'pending-module', { projectId: 'pending', chainId: 11155111 }, 0);
    await tx.write('chain-project-profiles', 'new-managed', { chainId: 1, profile: MANAGED_PROFILE }, 0);
  });
  assert.equal((await projectProfile(store, 'legacy')).profile, READONLY_PROFILE);
  await assert.rejects(projectProfile(store, 'legacy', { profile: MANAGED_PROFILE }), { code: 'project_profile_mismatch' });
  await assert.rejects(projectProfile(store, 'pending', { profile: MANAGED_PROFILE }), { code: 'project_profile_mismatch' });
  await assert.rejects(projectProfile(store, 'new-managed', { chainId: 11155111 }), { code: 'project_chain_mismatch' });
  assert.equal((await projectProfile(store, 'new-managed')).profile, MANAGED_PROFILE);
  await store.transaction(tx => tx.write('chain-bindings', 'new-managed', { chainId: 1, profile: READONLY_PROFILE }, 0));
  await assert.rejects(projectProfile(store, 'new-managed'), { code: 'project_profile_mismatch' });
});

test('managed admission starts closed and uses separate policy, capability and budget keys', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  for (const chainId of [1, 11155111]) {
    const legacy = chainProfile(chainId), managed = chainProfile(chainId, MANAGED_PROFILE);
    for (const key of ['policy', 'capability', 'usage']) assert.notEqual(managed[key], legacy[key]);
    const admission = createChainAdmission({ store, chainId, profile: MANAGED_PROFILE, now: () => Date.now() });
    await assert.rejects(admission.admitted(), { code: 'chain_public_not_enabled' });
  }
});

test('a managed adapter cannot settle a readonly reservation or reuse its assessment', async t => {
  const store=openStore(':memory:');t.after(()=>store.close());
  const {digest}=await import('../src/shared/index.mjs');
  const owner='0x'+'11'.repeat(20),executor='0x'+'22'.repeat(20),selection=chainProfile(1,MANAGED_PROFILE);
  const config={enabled:true,expiresAt:null,executor,executorCodeHash:'0x'+'33'.repeat(32),targetArtifactHash:digest('target'),
    reviewProjectId:'r',reviewCaseId:'r',reviewArtifactHash:digest('review'),maximumProjects:2,
    maximumTransactionGasWei:'5',maximumProjectGasWei:'10',maximumTotalGasWei:'20'};
  const adm=createChainAdmission({store,chainId:1,profile:MANAGED_PROFILE,now:()=>1800000000000,
    identity:{credential:async()=>({kind:'owner',principalId:'owner'})}});
  await store.transaction(async tx=>{
    await tx.write('network','authority',{ownerAddress:owner},0);
    await tx.write('principals','owner',{address:owner,chainId:1},0);
    await tx.write('network-capabilities',selection.capability,{...config,chainId:1,profile:MANAGED_PROFILE},0);
    await tx.write('review-cases','r',{projectId:'r',state:'reviewed',artifactHash:config.reviewArtifactHash,input:{buildHash:digest('build')}},0);
    await tx.write('chain-admission-assessments',digest({executor,targetArtifactHash:config.targetArtifactHash,reviewCaseId:'r',chainId:1}),{
      accepted:true,publicAdmission:true,chainId:1,executorCodeHash:config.executorCodeHash,reviewArtifactHash:config.reviewArtifactHash,reviewedBuildHash:digest('build')},0);
    await tx.write('public-chain-reservations',digest({id:'old'}),{projectId:'old',chainId:1,maximum:'5',settled:false},0);
  });
  await adm.publish('owner',{version:'candidate',config});await adm.activate('owner',{version:'candidate',expectedGeneration:0});
  await assert.rejects(adm.admitted(),{code:'chain_scope_not_reviewed'});
  await assert.rejects(store.transaction(tx=>adm.finalizeGas(tx,{id:'old',actual:'3'})),{code:'project_profile_mismatch'});
  assert.equal((await store.read('public-chain-reservations',digest({id:'old'}))).value.settled,false);
});

test('deployment rejects review chain and profile mismatches before reserving funds',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());const {createChainDeployments}=await import('../src/chain-deployments/index.mjs');
 let reviewed={state:'reviewed',artifactHash:'report',buildId:'build',profile:READONLY_PROFILE,chainId:11155111,input:{buildHash:'artifact'}};
 const deployments=createChainDeployments({store,identity:{authorize:async()=>{}},reviews:{get:async()=>reviewed},builds:{get:async()=>({state:'compiled',artifactHash:'artifact'})},artifacts:{get:async()=>({})},chain:{validateModule:()=>{throw Error('must reject before validation');}}});
 await assert.rejects(deployments.deployModule('actor','p',{caseId:'r',chainId:11155111,profile:MANAGED_PROFILE}),{code:'project_profile_mismatch'});
 reviewed={...reviewed,profile:MANAGED_PROFILE};
 await assert.rejects(deployments.deployModule('actor','p',{caseId:'r',chainId:1,profile:MANAGED_PROFILE}),{code:'project_chain_mismatch'});
 assert.equal((await store.list('chain-modules')).length,0);assert.equal((await store.list('public-chain-reservations')).length,0);
});
