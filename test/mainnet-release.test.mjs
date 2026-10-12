import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPublicClient, http, encodeAbiParameters, encodeDeployData, getContractAddress, keccak256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { openStore } from '../src/storage/index.mjs';
import { digest } from '../src/shared/index.mjs';
import { createArtifactStore } from '../src/artifact-store/index.mjs';
import { createSealer } from '../adapters/secrets.mjs';
import { deployMainnetRelease, requireMainnetApproval, stageMainnetCapability } from '../integration/mainnet-release.mjs';

test('a mainnet release requires the exact owner-approved and independently assessed plan', () => {
  const plan = {approvalSigner:'0x'+'11'.repeat(20),executorPayer:'0x'+'22'.repeat(20),recoveryOwner:'0x'+'33'.repeat(20),recoveryDelay:172800,bootstrapMaximumGas:30000000, runtimeCommit: 'a', contractCommit: 'b', buildHash: 'c' };
  const assessment = { status: 'accepted-for-mainnet-readonly', chainId: 1, sourceCommit: 'a', contractCommit: 'b', buildHash: 'c' };
  const authorization = { approved: true, planHash: digest(plan), owner: plan.recoveryOwner, expiresAt: Date.now()+60000 };
  requireMainnetApproval(plan, authorization, assessment);
  for(const changed of [{...plan,executorPayer:plan.approvalSigner},{...plan,recoveryDelay:60},{...plan,bootstrapMaximumGas:30000001}])
    assert.throws(()=>requireMainnetApproval(changed,{...authorization,planHash:digest(changed)},assessment));
  for (const changed of [{ ...plan, runtimeCommit: 'changed' }, { ...plan, fundingWei: '1' }])
    assert.throws(() => requireMainnetApproval(changed, authorization, assessment), { code: 'exact_mainnet_authorization_required' });
  assert.throws(() => requireMainnetApproval(plan, { ...authorization, revoked: true }, assessment), { code: 'exact_mainnet_authorization_required' });
  assert.throws(() => requireMainnetApproval(plan, authorization, { ...assessment, chainId: 11155111 }), { code: 'mainnet_scope_not_reviewed' });
});

test('local chain 1 release resumes one deployment and cannot stage altered source or activate spending',
  { skip: !process.env.CLAUS_TEST_MAINNET_RELEASE, timeout: 90000 }, async t => {
  const url = new URL(process.env.CLAUS_TEST_MAINNET_RELEASE); assert.equal(url.hostname, '127.0.0.1');
  const client = createPublicClient({ transport: http(url.href), cacheTime: 0 }); assert.equal(await client.getChainId(), 1);
  const signer = privateKeyToAccount(generatePrivateKey()), approval = privateKeyToAccount(generatePrivateKey()), recovery=privateKeyToAccount(generatePrivateKey());
  // Fee ceilings are intentional; the deterministic success fixture uses low fees.
  await client.request({method:'anvil_setNextBlockBaseFeePerGas',params:['0x5f5e100']});
  await client.request({method:'anvil_mine',params:['0x1']});
  await client.request({ method: 'anvil_setBalance', params: [signer.address, '0x56bc75e2d63100000'] });
  const source = JSON.parse(await readFile(new URL('../contracts/out/ClausApprovalExecutor.sol/ClausApprovalExecutor.json', import.meta.url)));
  const artifact = { abi: source.abi, creationBytecode: source.bytecode.object };
  const args = [approval.address, recovery.address, 172800n];
  const target={contract:'ClausReadonlyProject',standardInput:{},creationBytecode:'0x00'};
  const plan = { chainId: 1, profile: 'claus-readonly-v1', automaticRefill: false, buildHash: digest(artifact),
    approvalSigner: approval.address, executorPayer: signer.address, recoveryOwner: recovery.address, recoveryDelay: 172800, bootstrapMaximumGas:30000000,
    expectedExecutor: getContractAddress({ from: signer.address, nonce: 0n }), bootstrapMaximumWei: '4600000000000000',
    deploymentDataHash: keccak256(encodeDeployData({ abi: source.abi, bytecode: artifact.creationBytecode, args })),
    constructorArguments: encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint64'}], args),
    runtimeCommit: 'local-test-only', contractCommit: 'local-test-only', artifactProjectId: 'fixture',
    targetArtifactHash: digest(target), coreReviewCaseId: 'fixture-review', coreReviewArtifactHash: digest('review-fixture') };
  const assessment = { status: 'accepted-for-mainnet-readonly', chainId: 1, sourceCommit: plan.runtimeCommit, contractCommit: plan.contractCommit, buildHash: plan.buildHash };
  const authorization = { approved: true, planHash: digest(plan), owner: recovery.address, expiresAt: Date.now() + 3600000 };
  const store = openStore(':memory:'); t.after(() => store.close());
  const inputs = { store, client, signer, sealer: createSealer('33'.repeat(32)), plan, artifact, authorization, assessment,
    verification: { step: async ({address}) => {
      const proof={state:'verified',creationMatch:'exact_match',runtimeMatch:'exact_match',etherscanVerified:true,localFixture:true};
      await store.transaction(async tx=>{const id=digest({chainId:1,address:address.toLowerCase()}),old=await tx.read('chain-verifications',id);if(!old)await tx.write('chain-verifications',id,proof,0);});return proof;
    }} };
  let result = await deployMainnetRelease(inputs);
  await client.request({ method: 'anvil_mine', params: ['0x60','0x1'] });
  result = await deployMainnetRelease(inputs); assert.equal(result.state, 'verified');
  assert.equal(result.address.toLowerCase(), plan.expectedExecutor.toLowerCase());
  assert.equal((await deployMainnetRelease(inputs)).transactionHash, result.transactionHash);
  assert.equal(await client.getTransactionCount({ address: signer.address }), 1);
  await store.transaction(tx => tx.write('review-cases', plan.coreReviewCaseId, { state: 'reviewed', artifactHash: plan.coreReviewArtifactHash, input: { buildHash: plan.buildHash } }, 0));
  await store.transaction(tx=>createArtifactStore({store}).put(tx,'fixture',target));
  const cap = await stageMainnetCapability({ ...inputs, deployment: result });
  assert.equal(cap.chainId, 1); assert.equal(await store.read('policy-active', 'chain.mainnet.admission'), null);
  assert.equal(await store.read('network-capabilities', 'chain'), null);
  await assert.rejects(stageMainnetCapability({ ...inputs, deployment: { ...result, codeHash: '0x'+'00'.repeat(32) } }), { code: 'release_deployment_mismatch' });
});
