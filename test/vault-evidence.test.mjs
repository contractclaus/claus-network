import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'viem';
import { digest } from '../src/shared/index.mjs';
import { createChainEvidence } from '../adapters/chain-evidence.mjs';
import { validateVaultRuntime } from '../adapters/vault-evidence.mjs';

const address = n => '0x' + n.repeat(40);
function fixture() {
  const runtimeTemplate = '0x7f' + '00'.repeat(32) + '00', policy = address('2');
  const code = '0x7f' + policy.slice(2).padStart(64, '0') + '00';
  const standardInput = { sources: { 'src/ClausNativeVault.sol': { content: 'Local fixture only.' } } };
  const build = { status: 'compiled', contract: 'ClausNativeVault', entry: 'src/ClausNativeVault.sol',
    profile: { profile: 'solidity-static-compile-v1', compiler: '0.8.27+commit.40a35a09.Emscripten.clang' },
    standardInput, inputHash: digest(standardInput), immutableReferences: { '1': [{ start: 1, length: 32 }] },
    runtimeTemplate, runtimeTemplateHash: keccak256(runtimeTemplate) };
  const review = { complete: true, jobId: 'fixture', report: 'A local fixture, not an independent review.' };
  const vault = { state: 'verified', chainId: 11155111, profile: 'claus-native-principal-v1', projectId: 'prj_fixture',
    address: address('3'), codeHash: keccak256(code), artifactHash: digest(build), reviewArtifactHash: digest(review),
    policy: { target: policy, owner: address('4') } };
  const module = { address: address('1'), codeHash: keccak256('0x600000') };
  const state = { code, total: 10n };
  const client = { getChainId: async () => 11155111,
    getBlock: async () => ({ number: 42n, hash: '0x' + 'aa'.repeat(32), timestamp: 1000n }),
    getCode: async ({ address: at }) => at === vault.address ? state.code : '0x600000',
    getStorageAt: async () => '0x' + '00'.repeat(32),
    readContract: async ({ functionName, blockNumber, args }) => {
      assert.equal(blockNumber, 42n);
      if (functionName === 'admissionPolicy') return policy;
      if (functionName === 'principal') { assert.equal(args[0], vault.policy.owner); return 10n; }
      assert.equal(functionName, 'totalPrincipal'); return state.total;
    } };
  return { build, code, policy, vault, review, module, state, reader: createChainEvidence({ client }) };
}
test('consumer evidence binds the reviewed vault runtime, policy and principal at the same finalized block', async () => {
  const f = fixture(), snapshot = await f.reader.capture({ module: f.module,
    consumer: { vault: f.vault, build: f.build, review: f.review } });
  assert.equal(snapshot.consumer.policy, f.policy);
  assert.equal(snapshot.consumer.totalPrincipalWei, '10');
  assert.equal(snapshot.consumer.buildHash, digest(f.build));
  const p = { chainId: 11155111, implementation: f.module.address, toCodeHash: f.module.codeHash,
    dependencySnapshotHash: '0x' + digest(snapshot).slice(7) };
  await f.reader.validate(snapshot, p);
  f.state.code = '0x600100';
  await assert.rejects(f.reader.validate(snapshot, p), { code: 'dependency_code_changed' });
});
test('a different constructor policy, altered review or overlapping immutable patches cannot supply vault evidence', async () => {
  const f = fixture();
  assert.throws(() => validateVaultRuntime(f.build, digest(f.build), address('5'), f.code), { code: 'vault_evidence_invalid' });
  const overlap = structuredClone(f.build); overlap.immutableReferences['1'].push({ start: 1, length: 32 });
  assert.throws(() => validateVaultRuntime(overlap, digest(overlap), f.policy, f.code), { code: 'vault_evidence_invalid' });
  await assert.rejects(f.reader.capture({ module: f.module, consumer: {
    vault: f.vault, build: f.build, review: { ...f.review, report: 'unrelated' } } }), { code: 'vault_evidence_invalid' });
});
