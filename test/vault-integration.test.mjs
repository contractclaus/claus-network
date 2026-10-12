import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPublicClient, createWalletClient, http, encodeAbiParameters, keccak256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createApplication, listen } from '../runtime/server.mjs';
import { createClient } from '../interfaces/sdk.mjs';
import { createVaultExecutor } from '../adapters/vault-executor.mjs';
import { createSealer } from '../adapters/secrets.mjs';
import { openStore } from '../src/storage/index.mjs';
import { digest } from '../src/shared/index.mjs';
import { compileSnapshot } from '../adapters/compiler.mjs';
import { createChainEvidence } from '../adapters/chain-evidence.mjs';

test('external API deploys a fixed vault and prepares withdrawals that survive a broken policy and sponsor shutdown',
  { skip: !process.env.CLAUS_TEST_VAULT_CHAIN, timeout: 90000 }, async t => {
  const url = new URL(process.env.CLAUS_TEST_VAULT_CHAIN); assert.equal(url.hostname, '127.0.0.1');
  const client = createPublicClient({ transport: http(url.href, { retryCount: 0 }), cacheTime: 0 });
  assert.equal(await client.getChainId(), 11155111);
  await client.request({ method: 'anvil_reset', params: [] });
  const owner = privateKeyToAccount(generatePrivateKey()), payer = privateKeyToAccount(generatePrivateKey());
  for (const a of [owner, payer]) await client.request({ method: 'anvil_setBalance', params: [a.address, '0x56bc75e2d63100000'] });
  const wallet = createWalletClient({ account: owner, transport: http(url.href) });
  const contract = async name => JSON.parse(await readFile(new URL('../contracts/out/' + name + '.sol/' + name + '.json', import.meta.url)));
  const policySource = await contract('ClausVaultAdmission'), targetSource = await contract('ClausReadonlyProject');
  const vaultSource = await contract('ClausNativeVault');
  const vaultArtifact = await compileSnapshot({ files: [{ path: 'src/ClausNativeVault.sol',
    content: await readFile(new URL('../contracts/src/ClausNativeVault.sol', import.meta.url), 'utf8') }],
    entry: 'src/ClausNativeVault.sol', contract: 'ClausNativeVault' });
  const vaultReview = { complete: true, jobId: 'local-vault-fixture', report: 'Local fixture only, not an independent review.' };
  const deploy = async (source, args = []) => (await client.waitForTransactionReceipt({ hash: await wallet.deployContract({
    chain: null, abi: source.abi, bytecode: source.bytecode.object, args }) })).contractAddress;
  const module = await deploy(policySource), projectKey = keccak256('0x5678');
  // Local adapter fixture: the full approval executor lifecycle is tested
  // separately in ClausVaultLifecycle.t.sol. This target is controlled by the
  // test wallet so policy failure can be exercised without model fixtures.
  const target = await deploy(targetSource, [projectKey, module,
    encodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }], [true, 10000n])]);
  let time = Number((await client.getBlock()).timestamp) * 1000;
  const store = openStore(':memory:'); t.after(() => store.close());
  const app = createApplication({ store, now: () => time, rateSalt: 'vault-integration-only'.repeat(3), chainPorts: { client } });
  const server = await listen(app); t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const guest = createClient({ origin }), c = await guest.call('auth_challenge', { address: owner.address });
  const login = await guest.call('auth_session', { challengeId: c.id, signature: await owner.signMessage({ message: c.message }) });
  const api = createClient({ origin, token: login.token });
  const p = await api.call('project_create', { slug: 'vault-adapter', name: 'Vault adapter fixture', idempotencyKey: 'one' });
  const policy = { chainId: 11155111, profile: 'claus-readonly-v1', target, projectKey, executor: owner.address, owner: owner.address,
    codeHash: keccak256(await client.getCode({ address: target })), verification: { state: 'verified', localFixture: true } };
  const admission = { bindingHash: digest(policy), implementation: module,
    implementationCodeHash: keccak256(await client.getCode({ address: module })), configurationBytes: 64 };
  await store.transaction(async tx => {
    const hash = await app.artifacts.put(tx, p.id, vaultArtifact);
    const reviewHash = await app.artifacts.put(tx, p.id, vaultReview);
    await tx.write('network-capabilities', 'vaults', { enabled: true, chainId: 11155111,
      artifactProjectId: p.id, artifactHash: hash, reviewArtifactHash: reviewHash,
      policies: { [p.id]: admission } }, 0);
    await tx.write('review-pilots', p.id, { enabled: true, expiresAt: time + 86400000 }, 0);
    await tx.write('chain-bindings', p.id, policy, 0);
  });
  const executor = createVaultExecutor({ store, client, signer: payer, artifacts: app.artifacts,
    sealer: createSealer('fe'.repeat(32)), now: () => time,
    verification: { step: async () => ({ state: 'verified', localFixture: true }) } });
  await store.transaction(async tx => {
    const wrong = { ...policy, projectKey: keccak256('0xffff') };
    await tx.write('chain-bindings', p.id, wrong, 1);
    const cap = await tx.read('network-capabilities', 'vaults');
    await tx.write('network-capabilities', 'vaults', { ...cap.value,
      policies: { [p.id]: { ...admission, bindingHash: digest(wrong) } } }, cap.revision);
  });
  await api.call('vault_create', { projectId: p.id });
  assert.equal((await app.vaults.runOne(executor)).state, 'blocked');
  assert.equal((await store.list('chain-transactions')).length, 0, 'a mismatched onchain identity must not be signed');
  await store.transaction(async tx => {
    await tx.write('chain-bindings', p.id, policy, 2);
    const cap = await tx.read('network-capabilities', 'vaults');
    await tx.write('network-capabilities', 'vaults', { ...cap.value, policies: { [p.id]: admission } }, cap.revision);
  });
  await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ chain: null, address: target,
    abi: targetSource.abi, functionName: 'applyUpgrade', args: [module, '0x'] }) });
  await api.call('vault_create', { projectId: p.id });
  assert.equal((await app.vaults.runOne(executor)).state, 'blocked');
  assert.equal((await store.list('chain-transactions')).length, 0, 'an unsupported live policy must not be signed');
  await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ chain: null, address: target,
    abi: targetSource.abi, functionName: 'applyUpgrade', args: [module,
      encodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }], [true, 10000n])] }) });
  const first = await api.call('vault_create', { projectId: p.id }); let vault;
  assert.equal(first.attempt, 3);
  for (let i = 0; i < 8; i++) {
    await app.vaults.runOne(executor); vault = await api.call('vault_get', { projectId: p.id });
    if (vault.state === 'verified') break;
    assert.equal((await api.call('vault_create', { projectId: p.id })).id, first.id);
    await client.request({ method: 'evm_increaseTime', params: [31] });
    await client.request({ method: 'anvil_mine', params: ['0x3', '0x1'] }); time = Number((await client.getBlock()).timestamp) * 1000;
  }
  assert.equal(vault.state, 'verified'); assert.equal((await store.list('chain-transactions')).length, 1);
  const send = async request => client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({
    chain: null, to: request.to, data: request.data, value: BigInt(request.value) }) });
  await assert.rejects(api.call('vault_transaction', { projectId: p.id, kind: 'withdraw', amountWei: '1', recipient: vault.address }), { code: 'invalid_address' });
  await assert.rejects(api.call('vault_transaction', { projectId: p.id, kind: 'deposit', amountWei: '1', recipient: owner.address }), { code: 'invalid_vault_action' });
  const deposit = await api.call('vault_transaction', { projectId: p.id, kind: 'deposit', amountWei: '1000' });
  assert.equal((await send(deposit)).status, 'success');
  await client.request({ method: 'anvil_mine', params: ['0x60', '0x1'] });
  const evidence = await createChainEvidence({ client }).capture({
    module: { address: module, codeHash: admission.implementationCodeHash },
    consumer: { vault, build: vaultArtifact, review: vaultReview }
  });
  assert.equal(evidence.consumer.policy, target.toLowerCase());
  assert.equal(evidence.consumer.ownerPrincipalWei, '1000');
  assert.equal(evidence.consumer.totalPrincipalWei, '1000');
  assert.equal(evidence.consumer.vault.codeHash, vault.codeHash);
  const policyBreak = await wallet.writeContract({ chain: null, address: target, abi: targetSource.abi,
    functionName: 'applyUpgrade', args: [module, '0x'] });
  await client.waitForTransactionReceipt({ hash: policyBreak });
  await assert.rejects(send(deposit));
  await store.transaction(async tx => {
    const cap = await tx.read('network-capabilities', 'vaults');
    await tx.write('network-capabilities', 'vaults', { ...cap.value, enabled: false }, cap.revision);
    await tx.write('review-pilots', p.id, { enabled: false }, 1);
  });
  const withdraw = await api.call('vault_transaction', { projectId: p.id, kind: 'withdraw', amountWei: '1000', recipient: owner.address });
  assert.equal(withdraw.value, '0'); assert.equal((await send(withdraw)).status, 'success');
  assert.equal(await client.getBalance({ address: vault.address }), 0n);
  assert.equal(await client.readContract({ address: vault.address, abi: vaultSource.abi, functionName: 'principal', args: [owner.address] }), 0n);
  assert.equal(keccak256(await client.getCode({ address: vault.address })), vault.codeHash);
});
