import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPublicClient, createWalletClient, http, keccak256, stringToHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { prepareContractRequest, locateContractRequest } from '../reference/contract-request-client.mjs';
import { digest } from '../src/shared/index.mjs';

test('the public client prepares a real requester call and resumes the same receipt without resubmitting',
  { skip: !process.env.CLAUS_TEST_CHAIN, timeout: 60000 }, async () => {
  const url = new URL(process.env.CLAUS_TEST_CHAIN);
  assert.equal(url.hostname, '127.0.0.1', 'Fixtures must stay on the local chain');
  const chain = createPublicClient({ transport: http(url.href, { retryCount: 0 }), cacheTime: 0 });
  const chainId=await chain.getChainId();assert([1,11155111].includes(chainId));
  const account = privateKeyToAccount(generatePrivateKey());
  await chain.request({ method: 'anvil_setBalance', params: [account.address, '0x56bc75e2d63100000'] });
  const wallet = createWalletClient({ account, transport: http(url.href) });
  const deploy = async (name, args) => {
    const artifact = JSON.parse(await readFile(new URL(`../contracts/out/${name}.sol/${name}.json`, import.meta.url)));
    const hash = await wallet.deployContract({ chain: null, abi: artifact.abi, bytecode: artifact.bytecode.object, args });
    const receipt = await chain.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success'); return receipt.contractAddress;
  };
  const inbox = await deploy('ClausRequestInbox', [account.address]);
  const requester = await deploy('ClausRequestClient', [inbox, account.address]);
  await chain.request({ method: 'anvil_mine', params: ['0x60', '0x1'] });
  const now = Number((await chain.getBlock()).timestamp) * 1000;
  const id = digest({ local: 'public-client-binding' }), projectId = 'local-project';
  const binding = { id, projectId, onchainBinding: '0x' + id.slice(7), requester, inbox,
    chainId, codeHash: keccak256(await chain.getCode({ address: inbox })),
    capability: keccak256(stringToHex('claus.proposal.create.v1')), expiresAt: now + 86400000,
    used: 0, maxRequests: 1, revokedAt: null };
  const api = { call: async (method, args) => {
    assert.equal(method, 'contract_binding_get'); assert.deepEqual(args, { projectId, bindingId: id });
    return structuredClone(binding);
  } };
  const pin = { chainId, inbox, codeHash: binding.codeHash, requester,
    requesterCodeHash: keccak256(await chain.getCode({ address: requester })), controller: account.address };
  const options = { api, chain, projectId, bindingId: id, pin, input: { moduleId: 'local-module', configuration: '0x1234' },
    deadline: Math.floor(now / 1000) + 3600, now };
  const nonce = await chain.getTransactionCount({ address: account.address });
  const prepared = await prepareContractRequest(options);
  assert.equal(prepared.callbackGas, 1000000);
  assert.equal(await chain.getTransactionCount({ address: account.address }), nonce, 'preparation never sends');
  binding.revokedAt = now;
  await assert.rejects(prepareContractRequest(options), { code: 'binding_inactive' });
  binding.revokedAt = null;
  await assert.rejects(prepareContractRequest({ ...options, pin: { ...pin, requesterCodeHash: '0x' + '00'.repeat(32) } }), { code: 'deployment_code_mismatch' });
  await assert.rejects(prepareContractRequest({ ...options, pin: { ...pin, controller: '0x' + '11'.repeat(20) } }), { code: 'requester_authority_mismatch' });
  await assert.rejects(prepareContractRequest({ ...options, chain: { getChainId: async () => chainId===1?11155111:1 } }), { code: 'wrong_chain' });
  const hash = await wallet.sendTransaction({ chain: null, to: prepared.transaction.to,
    data: prepared.transaction.data, value: BigInt(prepared.transaction.value) });
  await chain.waitForTransactionReceipt({ hash });
  const first = await locateContractRequest({ chain, prepared, transactionHash: hash });
  assert.equal(first.finalized, false);
  await chain.request({ method: 'anvil_mine', params: ['0x60', '0x1'] });
  const resumed = await locateContractRequest({ chain, prepared, transactionHash: hash });
  assert.equal(resumed.finalized, true); assert.equal(resumed.requestId, first.requestId);
  assert.equal(await chain.getTransactionCount({ address: account.address }), nonce + 1);
  await assert.rejects(locateContractRequest({ chain, prepared: { ...prepared, inputHash: digest('different') }, transactionHash: hash }),
    { code: 'request_event_mismatch' });
  await assert.rejects(locateContractRequest({ chain, prepared: { ...prepared, callbackGas: 200000 }, transactionHash: hash }),
    { code: 'request_event_mismatch' });
});
