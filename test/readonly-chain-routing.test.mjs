import test from 'node:test';
import assert from 'node:assert/strict';
import { hashTypedData } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { domain } from '../adapters/chain-read.mjs';
import { createReadonlyChainRouter } from '../adapters/readonly-chain-router.mjs';
import { createReadonlyTransactions, createSepoliaTransactions } from '../adapters/sepolia-transactions.mjs';
import { createSealer } from '../adapters/secrets.mjs';
import { openStore } from '../src/storage/index.mjs';

test('readonly routing and signature domains separate mainnet from the existing testnet', async () => {
  const ports = id => ({ registration: async () => id, captureEvidence: async () => id, proposal: async () => id });
  const chain = createReadonlyChainRouter({ sepolia: ports(11155111), mainnet: ports(1) });
  assert.equal(await chain.registration({ capability: { chainId: 1 } }), 1);
  assert.equal(await chain.captureEvidence({ module: { chainId: 11155111 } }), 11155111);
  assert.equal(await chain.proposal({ binding: { chainId: 1 } }), 1);
  assert.throws(() => chain.proposal({ binding: { chainId: 8453 } }), { code: 'unsupported_chain' });
  assert.throws(() => createReadonlyChainRouter({ sepolia: ports(11155111) }).proposal({ binding: { chainId: 1 } }), { code: 'chain_not_configured' });
  const typed = { types: { Check: [{ name: 'nonce', type: 'uint256' }] }, primaryType: 'Check', message: { nonce: 1n } };
  const address = '0x' + '11'.repeat(20);
  assert.notEqual(hashTypedData({ ...typed, domain: domain(address, 1) }), hashTypedData({ ...typed, domain: domain(address) }));
});

test('an existing transaction cannot be read or broadcast through another chain adapter', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  const signer = privateKeyToAccount(generatePrivateKey());
  const client = { getChainId: async () => 1, estimateGas: async () => 100000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 1000000n, maxPriorityFeePerGas: 0n }),
    getTransactionCount: async () => 0, getBalance: async () => 10000000000000000n };
  const common = { store, client, signer, sealer: createSealer('11'.repeat(32)), authorize: async () => true };
  const mainnet = createReadonlyTransactions({ ...common, chainId: 1 });
  await mainnet.prepare({ id: 'one', data: '0x6000', authority: { kind: 'fixture' }, expiresAt: Date.now() + 60000 });
  const testnet = createSepoliaTransactions({ ...common, client: { ...client, getChainId: async () => 11155111 } });
  await assert.rejects(testnet.status('one'), { code: 'transaction_not_found' });
  await assert.rejects(testnet.submit('one'), { code: 'transaction_not_found' });
  assert.equal((await mainnet.status('one')).state, 'prepared');
});
