import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { keccak256, parseTransaction } from 'viem';
import { openPostgresStore } from '../src/postgres/index.mjs';
import { digest } from '../src/shared/index.mjs';
import { createSealer } from '../adapters/secrets.mjs';
import { admitContractDispatchBudget, revokeContractDispatchBudget, createContractDelivery } from '../adapters/contract-delivery.mjs';

const credentials = process.env.NETWORK_TEST_CREDENTIAL_FILE;
neonConfig.webSocketConstructor = ws;
test('PostgreSQL dispatch: competing hosts preserve one signed result and settle after revocation',
  { skip: !credentials, timeout: 180000 }, async t => {
    const settings = JSON.parse(await readFile(credentials, 'utf8'));
    const schema = 'dispatch_acceptance_' + randomBytes(8).toString('hex');
    const pool = () => new Pool({ connectionString: settings.migrationUrl, connectionTimeoutMillis: 10000, max: 3 });
    const admin = pool(), store = await openPostgresStore({ pool: admin, schema, migrate: true });
    let second = await openPostgresStore({ pool: pool(), schema });
    t.after(async () => { await second.close(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await store.close(); });
    const signer = privateKeyToAccount(generatePrivateKey()), now = Date.now();
    const inbox = '0x' + '22'.repeat(20), codeHash = '0x' + '33'.repeat(32);
    const budget = { id: 'postgres-fixture', chainId: 11155111, dispatcher: signer.address.toLowerCase(),
      inbox, codeHash, projectIds: ['test-project'], expiresAt: now + 3600000,
      maximumTotal: '200000000000', maximumTransaction: '200000000000',
      maximumGas: '1000000', maximumFeePerGas: '1000000' };
    await admitContractDispatchBudget(store, budget);
    const observation = { inbox, codeHash, requester: '0x' + '44'.repeat(20), deadline: Math.floor(now / 1000) + 1800 };
    const request = { id: digest('postgres-fixture'), projectId: 'test-project', bindingId: 'test-binding',
      observation, observationHash: digest(observation), state: 'result_ready',
      result: { kind: 'proposal-decision', decision: 'approve', decisionHash: digest('synthetic-decision') } };
    await store.transaction(async tx => {
      await tx.write('contract-requests', request.id, request, 0);
      await tx.write('contract-bindings', request.bindingId, { ...observation, projectId: request.projectId,
        actor: 'test-agent', expiresAt: budget.expiresAt, revokedAt: null }, 0);
    });
    let broadcasts = 0, resolved = false, final = false;
    const sent = new Map(), blockHash = '0x' + '55'.repeat(32);
    const client = { getChainId: async () => 11155111, estimateGas: async () => 100000n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 1000000n, maxPriorityFeePerGas: 0n }),
      getTransactionCount: async () => 0, getBalance: async () => 1000000000000000000n,
      sendRawTransaction: async ({ serializedTransaction }) => {
        broadcasts++; sent.set(keccak256(serializedTransaction), parseTransaction(serializedTransaction));
        throw Error('synthetic lost response after delivery');
      },
      getTransactionReceipt: async ({ hash }) => {
        if (!resolved) throw Error('pending');
        return { transactionHash: hash, blockNumber: 100n, blockHash, contractAddress: null,
          status: 'success', gasUsed: 90000n, effectiveGasPrice: 1000000n };
      },
      getBlockNumber: async () => 103n,
      getBlock: async ({ blockTag }) => ({ number: blockTag === 'finalized' && !final ? 99n : 103n, hash: blockHash }),
      getTransaction: async ({ hash }) => {
        const transaction = sent.get(hash);
        return { ...transaction, from: signer.address, input: transaction.data, value: transaction.value ?? 0n };
      } };
    const chain = { profile: async () => ({ chainId: 11155111, inbox, codeHash }),
      resolution: async () => ({ chainId: 11155111, from: signer.address, to: inbox, value: '0',
        data: '0x1234', expiresAt: observation.deadline * 1000, callback: null }),
      deliveryState: async () => ({ pending: !resolved, resolved, callbackDelivered: false, closed: false,
        blockNumber: final ? 103 : 99, finalized: final }) };
    const identity = { authorize: async () => {} };
    const make = db => createContractDelivery({ store: db, signer, client, chain, identity, budget,
      sealer: createSealer('11'.repeat(32)), now: () => now });
    const input = { id: digest({ requestId: request.id, action: 'result-delivery' }), request, allowSubmit: true };
    await Promise.all([make(store).step(input), make(second).step(input)]);
    assert.equal(broadcasts, 1);
    let ledger = (await store.read('contract-dispatch-budgets', budget.id)).value;
    assert.equal(ledger.reserved, '135000000000'); assert.equal(ledger.spent, '0');
    const original = (await store.list('chain-transactions'))[0].value;
    assert.equal(original.state, 'unknown'); assert.equal(sent.has(original.hash), true);
    await second.close(); second = await openPostgresStore({ pool: pool(), schema });
    await revokeContractDispatchBudget(second, budget.id);
    resolved = true;
    assert.equal((await make(second).step({ ...input, allowSubmit: false })).state, 'pending');
    final = true;
    const completed = await Promise.all([make(store).step({ ...input, allowSubmit: false }),
      make(second).step({ ...input, allowSubmit: false })]);
    assert(completed.every(result => result.state === 'delivered' && result.transactionHash === original.hash));
    ledger = (await store.read('contract-dispatch-budgets', budget.id)).value;
    assert.equal(ledger.reserved, '0'); assert.equal(ledger.spent, '90000000000');
    assert.equal(broadcasts, 1); assert.equal((await store.list('chain-transactions')).length, 1);
    assert.equal((await store.list('contract-dispatch-reservations')).length, 1);
    const [slot] = await store.list('chain-wallet-slots');
    assert.deepEqual(slot.value, { id: null, minimumNonce: 1 });
    t.diagnostic('Disposable PostgreSQL schema only; signing and chain responses are synthetic, with no network broadcast.');
  });
