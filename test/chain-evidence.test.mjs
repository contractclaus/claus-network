import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'viem';
import { createChainEvidence, inspectCode, PROXY_SLOTS, validateBuildEvidence } from '../adapters/chain-evidence.mjs';
import { digest } from '../src/shared/index.mjs';
import { authorityDenied } from '../adapters/authorization.mjs';

const at = n => '0x' + n.repeat(40), hash = n => '0x' + n.repeat(64);
function fixture() {
  const code = '0x60f460f260ff00', module = { address: at('1'), codeHash: keccak256(code) };
  const state = { code, blockHash: hash('a'), slot: '0x' + '0'.repeat(64), result: hash('0') };
  const client = {
    getChainId: async () => 11155111,
    getBlock: async () => ({ number: 42n, hash: state.blockHash, timestamp: 1000n }),
    getCode: async () => state.code,
    getStorageAt: async ({ slot }) => { assert(PROXY_SLOTS.includes(slot)); return state.slot; },
    call: async ({ blockNumber, gas }) => { assert.equal(blockNumber, 42n); assert.equal(gas, 250000n); return { data: state.result }; }
  };
  return { state, module, reader: createChainEvidence({ client }) };
}
test('finalized evidence binds real runtime and calls; changed balances do not impersonate changed code', async () => {
  const f = fixture(), snapshot = await f.reader.capture({ module: f.module, dependencies: [{ address: at('2'), callData: '0x12345678' }] });
  assert.equal(snapshot.dependencies[0].call.result, hash('0'));
  const proposal = { chainId: 11155111, implementation: f.module.address, toCodeHash: f.module.codeHash,
    dependencySnapshotHash: '0x' + digest(snapshot).slice(7) };
  f.state.result = hash('1'); await f.reader.validate(snapshot, proposal);
  const altered = structuredClone(snapshot); altered.dependencies[0].call.result = hash('2');
  await assert.rejects(f.reader.validate(altered, proposal), { code: 'dependency_evidence_mismatch' });
  f.state.code = '0x600100'; await assert.rejects(f.reader.validate(snapshot, proposal), { code: 'dependency_code_changed' });
  f.state.code = snapshot.implementation.code; f.state.blockHash = hash('b');
  await assert.rejects(f.reader.validate(snapshot, proposal), { code: 'evidence_block_changed' });
});
test('direct-contract evidence rejects absent code, delegate paths, proxy slots and oversized results', async () => {
  assert.doesNotThrow(() => inspectCode('0x60f460f260ff00'));
  for (const code of ['0x', '0xef0100' + '11'.repeat(20), '0x6000f4', '0x6000f2', '0x6000ff']) assert.throws(() => inspectCode(code));
  const f = fixture(); f.state.slot = hash('1');
  await assert.rejects(f.reader.capture({ module: f.module }), { code: 'dependency_proxy_unsupported' });
  f.state.slot = hash('0'); f.state.result = '0x' + '00'.repeat(8193);
  await assert.rejects(f.reader.capture({ module: f.module, dependencies: [{ address: at('2'), callData: '0x1234' }] }), { code: 'dependency_call_invalid' });
  assert.equal(authorityDenied({ code: 'dependency_code_changed' }), true);
  assert.equal(authorityDenied({ code: 'rpc_timeout' }), false);
});
test('compiler evidence must be the reviewed artifact, exact source and exact deployed runtime', () => {
  const files = [{ path: 'Lens.sol', content: 'local fixture' }], standardInput = { sources: { 'Lens.sol': { content: 'local fixture' } } };
  const build = { status: 'compiled', profile: { profile: 'solidity-static-compile-v1' }, entry: 'Lens.sol', standardInput,
    inputHash: digest(standardInput), immutableReferences: {}, runtimeTemplate: '0x6000', runtimeTemplateHash: keccak256('0x6000') };
  const source = { buildHash: digest(build), entry: 'Lens.sol', files }, implementation = { code: '0x6000', codeHash: keccak256('0x6000') };
  assert.doesNotThrow(() => validateBuildEvidence(build, source, implementation));
  assert.throws(() => validateBuildEvidence(build, source, { code: '0x6001', codeHash: keccak256('0x6001') }));
  assert.throws(() => validateBuildEvidence(build, { ...source, files: [{ ...files[0], content: 'unreviewed source' }] }, implementation));
  assert.throws(() => validateBuildEvidence({ ...build, entry: 'Other.sol' }, source, implementation));
});
