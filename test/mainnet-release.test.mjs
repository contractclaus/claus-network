import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPublicClient, http, encodeAbiParameters, encodeDeployData, getContractAddress, keccak256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { openStore } from '../src/storage/index.mjs';
import { digest } from '../src/shared/index.mjs';
import { createSealer } from '../adapters/secrets.mjs';
import { deployMainnetRelease, requireMainnetApproval, stageMainnetCapability } from '../integration/mainnet-release.mjs';

test('a mainnet release requires the exact owner-approved and independently assessed plan', () => {
  const plan = { recoveryOwner: '0x12', runtimeCommit: 'a', contractCommit: 'b', buildHash: 'c' };
  const assessment = { status: 'accepted-for-mainnet-readonly', chainId: 1, sourceCommit: 'a', contractCommit: 'b', buildHash: 'c' };
  const authorization = { approved: true, planHash: digest(plan), owner: '0x12' };
  requireMainnetApproval(plan, authorization, assessment);
  for (const changed of [{ ...plan, runtimeCommit: 'changed' }, { ...plan, fundingWei: '1' }])
    assert.throws(() => requireMainnetApproval(changed, authorization, assessment), { code: 'exact_mainnet_authorization_required' });
  assert.throws(() => requireMainnetApproval(plan, { ...authorization, revoked: true }, assessment), { code: 'exact_mainnet_authorization_required' });
  assert.throws(() => requireMainnetApproval(plan, authorization, { ...assessment, chainId: 11155111 }), { code: 'mainnet_scope_not_reviewed' });
});

test('local chain 1 release resumes one deployment and cannot stage altered source or activate spending',
  { skip: !process.env.CLAUS_TEST_MAINNET_RELEASE, timeout: 90000 }, async t => {
  const url = new URL(process.env.CLAUS_TEST_MAINNET_RELEASE); assert.equal(url.hostname, '127.0.0.1');
  const client = createPublicClient({ transport: http(url.href), cacheTime: 0 }); assert.equal(await client.getChainId(), 1);
  const signer = privateKeyToAccount(generatePrivateKey()), approval = privateKeyToAccount(generatePrivateKey());
  await client.request({ method: 'anvil_setBalance', params: [signer.address, '0x56bc75e2d63100000'] });
  const source = JSON.parse(await readFile(new URL('../contracts/out/ClausApprovalExecutor.sol/ClausApprovalExecutor.json', import.meta.url)));
  const artifact = { abi: source.abi, creationBytecode: source.bytecode.object };
  const args = [approval.address, signer.address, 172800n];
  const plan = { chainId: 1, profile: 'claus-readonly-v1', automaticRefill: false, buildHash: digest(artifact),
    approvalSigner: approval.address, executorPayer: signer.address, recoveryOwner: signer.address, recoveryDelay: 172800,
    expectedExecutor: getContractAddress({ from: signer.address, nonce: 0n }), bootstrapMaximumWei: '4600000000000000',
    deploymentDataHash: keccak256(encodeDeployData({ abi: source.abi, bytecode: artifact.creationBytecode, args })),
    constructorArguments: encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint64'}], args),
    runtimeCommit: 'local-test-only', contractCommit: 'local-test-only', artifactProjectId: 'fixture',
    targetArtifactHash: digest('target-fixture'), coreReviewCaseId: 'fixture-review', coreReviewArtifactHash: digest('review-fixture') };
  const assessment = { status: 'accepted-for-mainnet-readonly', chainId: 1, sourceCommit: plan.runtimeCommit, contractCommit: plan.contractCommit, buildHash: plan.buildHash };
  const authorization = { approved: true, planHash: digest(plan), owner: signer.address, expiresAt: Date.now() + 3600000 };
  const store = openStore(':memory:'); t.after(() => store.close());
  const inputs = { store, client, signer, sealer: createSealer('33'.repeat(32)), plan, artifact, authorization, assessment,
    verification: { step: async () => ({ state: 'verified', creationMatch: 'exact_match', runtimeMatch: 'exact_match', localFixture: true }) } };
  let result = await deployMainnetRelease(inputs);
  await client.request({ method: 'anvil_mine', params: ['0x60','0x1'] });
  result = await deployMainnetRelease(inputs); assert.equal(result.state, 'verified');
  assert.equal(result.address.toLowerCase(), plan.expectedExecutor.toLowerCase());
  assert.equal((await deployMainnetRelease(inputs)).transactionHash, result.transactionHash);
  assert.equal(await client.getTransactionCount({ address: signer.address }), 1);
  await store.transaction(tx => tx.write('review-cases', plan.coreReviewCaseId, { state: 'reviewed', artifactHash: plan.coreReviewArtifactHash, input: { buildHash: plan.buildHash } }, 0));
  const cap = await stageMainnetCapability({ ...inputs, deployment: result });
  assert.equal(cap.chainId, 1); assert.equal(await store.read('policy-active', 'chain.mainnet.admission'), null);
  assert.equal(await store.read('network-capabilities', 'chain'), null);
  await assert.rejects(stageMainnetCapability({ ...inputs, deployment: { ...result, codeHash: '0x'+'00'.repeat(32) } }), { code: 'release_deployment_mismatch' });
});
