import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, keccak256 } from 'viem';
import { captureMarketPolicy, validateMarketPolicy } from '../adapters/market-policy.mjs';
const address = n => '0x' + n.repeat(40), word = n => '0x' + n.repeat(64);
function fixture() {
  const code = '0x600060005260206000f3';
  const admission = { profile: 'claus-market-directional-fee-v1', chainId: 1,
    executor: address('1'), policy: address('2'), owner: address('3'), approvalSigner: address('4'), module: address('5'),
    executorCodeHash: keccak256(code), policyCodeHash: keccak256(code), moduleCodeHash: keccak256(code),
    projectKey: word('1'), mandateHash: word('2'), policyVersion: word('3'), minimumDelaySeconds: 3600,
    maximumFee: 10000, policyGeneration: 1, authorityGeneration: 2, clausGeneration: 3 };
  const reads = { projects: [admission.owner, admission.policy, admission.mandateHash, admission.policyVersion, 3600n, 1n, 2n, true],
    clausSigner: admission.approvalSigner, pendingSigner: address('0'), pendingProjectOwners: address('0'), clausGeneration: 3n,
    executor: admission.executor, projectId: admission.projectKey, implementation: admission.module,
    implementationCodeHash: admission.moduleCodeHash, configuration: encodeAbiParameters([{ type: 'uint24' }, { type: 'uint24' }], [3000, 5000]), version: 1n };
  const f = { admission, reads, code, changedBlock: false, seen: [] };
  f.client = { getChainId: async () => 1, getBlock: async arg => ({ number: 500n, hash: arg.blockNumber && f.changedBlock ? word('9') : word('4') }),
    getCode: async arg => { f.seen.push(arg); return f.code; },
    readContract: async arg => { f.seen.push(arg); return f.reads[arg.functionName]; } };
  return f;
}

test('market policy evidence binds the actual registered target and finite authority at one finalized block', async () => {
  const f = fixture(), out = await captureMarketPolicy(f);
  assert.equal(out.policy, f.admission.policy); assert.equal(out.zeroToOneFee, 3000); assert.equal(out.oneToZeroFee, 5000);
  assert.equal(out.minimumDelaySeconds, 3600); assert.equal(out.launchAuthorized, false);
  assert(f.seen.every(call => call.blockNumber === 500n));
});

test('a separately deployed policy shell cannot claim the registered project authority', async () => {
  const f = fixture(); f.reads.projects[1] = address('8');
  await assert.rejects(captureMarketPolicy(f), { code: 'market_policy_not_registered' });
});

test('revocation, owner transfer, signer recovery and changed generations invalidate market evidence', async () => {
  for (const change of [f => { f.reads.projects[7] = false; }, f => { f.reads.pendingSigner = address('6'); },
    f => { f.reads.pendingProjectOwners = address('6'); }, f => { f.reads.clausGeneration = 4n; },
    f => { f.reads.projects[4] = 1n; }, f => { f.reads.clausSigner = address('6'); }]) {
    const f = fixture(); change(f);
    await assert.rejects(captureMarketPolicy(f), error => ['market_policy_suspended', 'market_policy_authority_changed'].includes(error.code));
  }
});

test('substituted runtime, module, oversized fees and reorgs are rejected', async () => {
  for (const [change, code] of [
    [f => { f.code = '0x6001'; }, 'market_policy_code_changed'],
    [f => { f.reads.implementation = address('7'); }, 'market_policy_module_changed'],
    [f => { f.reads.configuration = encodeAbiParameters([{type:'uint24'},{type:'uint24'}],[20000,3000]); }, 'market_policy_fee_exceeds_ceiling'],
    [f => { f.changedBlock = true; }, 'evidence_block_changed']
  ]) { const f = fixture(); change(f); await assert.rejects(captureMarketPolicy(f), { code }); }
});

test('even a matching delegated-account code hash is outside the admitted direct-contract profile', async () => {
  const f = fixture(); f.code = '0xef0100' + address('8').slice(2);
  for (const key of ['executorCodeHash', 'policyCodeHash', 'moduleCodeHash']) f.admission[key] = keccak256(f.code);
  await assert.rejects(captureMarketPolicy(f), { code: 'dependency_delegation_unsupported' });
});

test('unfinalized revocation or a changed configuration invalidates saved market evidence', async () => {
  const f = fixture(), observation = await captureMarketPolicy(f);
  const confirmed = await validateMarketPolicy({ ...f, observation });
  assert.equal(confirmed.launchAuthorized, false);
  f.reads.projects[7] = false;
  await assert.rejects(validateMarketPolicy({ ...f, observation }), { code: 'market_policy_suspended' });
  f.reads.projects[7] = true;
  f.reads.configuration = encodeAbiParameters([{ type: 'uint24' }, { type: 'uint24' }], [4000, 5000]);
  await assert.rejects(validateMarketPolicy({ ...f, observation }), { code: 'market_policy_observation_stale' });
});

test('edited observations and observations from another admission cannot be reused', async () => {
  const f = fixture(), observation = await captureMarketPolicy(f);
  await assert.rejects(validateMarketPolicy({ ...f, observation: { ...observation, maximumFee: 20000 } }),
    { code: 'invalid_market_policy_observation' });
  f.admission.maximumFee = 20000;
  await assert.rejects(validateMarketPolicy({ ...f, observation }), { code: 'invalid_market_policy_observation' });
});
