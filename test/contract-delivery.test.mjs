import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { keccak256, parseTransaction } from 'viem';
import { openStore } from '../src/storage/index.mjs';
import { digest } from '../src/shared/index.mjs';
import { createSealer } from '../adapters/secrets.mjs';
import { admitContractDispatchBudget, revokeContractDispatchBudget, createContractDelivery } from '../adapters/contract-delivery.mjs';

async function fixture(t, callback = false) {
  const store = openStore(':memory:'); t.after(() => store.close());
  const signer = privateKeyToAccount(generatePrivateKey());
  const inbox = '0x' + '22'.repeat(20), codeHash = '0x' + '33'.repeat(32), now = Date.now();
  const budget = { id: 'fixture-budget', chainId: 11155111, dispatcher: signer.address.toLowerCase(), inbox,
    codeHash, projectIds: ['project-a'], expiresAt: now + 86400000, maximumTotal: '1000000000000',
    maximumTransaction: '200000000000', maximumGas: '1000000', maximumFeePerGas: '1000000' };
  await admitContractDispatchBudget(store, budget);
  const observation = { inbox, codeHash, requester: '0x' + '44'.repeat(20), deadline: Math.floor(now / 1000) + 3600 };
  const request = { id: digest({ fixture: 1 }), projectId: 'project-a', bindingId: 'binding-a', state: 'result_ready',
    observation, observationHash: digest(observation), result: { kind: 'proposal-decision', decision: 'approve', decisionHash: digest('fixture-decision') } };
  await store.transaction(async tx => {
    await tx.write('contract-requests', request.id, request, 0);
    await tx.write('contract-bindings', request.bindingId, { ...observation, projectId: request.projectId,
      actor: 'fixture-agent', expiresAt: budget.expiresAt, revokedAt: null }, 0);
  });
  let resolved = false, callbackDelivered = false, currentHeight = 99n, broadcasts = 0, identityChecks = 0, denyAt = Infinity;
  const sent = new Map(), receipts = new Map();
  const client = { getChainId: async () => 11155111, estimateGas: async () => 100000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 1000000n, maxPriorityFeePerGas: 0n }),
    getTransactionCount: async () => 0, getBalance: async () => 1000000000000000000n,
    sendRawTransaction: async ({ serializedTransaction }) => {
      broadcasts++; sent.set(keccak256(serializedTransaction), parseTransaction(serializedTransaction)); throw Error('lost response');
    },
    getTransactionReceipt: async ({ hash }) => { if (!receipts.has(hash)) throw Error('pending'); return receipts.get(hash); },
    getBlockNumber: async () => 103n,
    getBlock: async () => ({ number: currentHeight, hash: '0x' + '55'.repeat(32) }),
    getTransaction: async ({ hash }) => { const tx = sent.get(hash); return { ...tx, from: signer.address, input: tx.data, value: tx.value ?? 0n }; }
  };
  const chain = { profile: async () => ({ chainId: 11155111, inbox, codeHash }),
    resolution: async r => ({ chainId: 11155111, from: signer.address, to: inbox, value: '0', data: '0x1234',
      expiresAt: r.observation.deadline * 1000, callback: callback ? { to: inbox, value: '0', data: '0x5678' } : null }),
    deliveryState: async () => ({ pending: !resolved, resolved, callbackDelivered, closed: false,
      blockNumber: Number(currentHeight), finalized: true }) };
  const identity = { authorize: async () => { if (++identityChecks >= denyAt) throw Object.assign(Error('denied'), { code: 'scope_denied' }); } };
  let admissionChecks = 0, withdrawAdmissionAt = Infinity;
  const make = () => createContractDelivery({ store, client, signer, sealer: createSealer('11'.repeat(32)), chain, identity, budget,
    admitted: async (_reader, projectId) => projectId === 'project-a' && ++admissionChecks < withdrawAdmissionAt, now: () => now });
  const input = { id: digest({ requestId: request.id, action: 'result-delivery' }), request, allowSubmit: true };
  return { store, budget, make, input, client, broadcasts: () => broadcasts, denyAt: n => { denyAt = n; },
    withdrawAdmissionAt: n => { withdrawAdmissionAt = n; },
    ledger: async () => (await store.read('contract-dispatch-budgets', budget.id)).value,
    confirm: (deliverCallback = true, final = true) => {
      currentHeight = final ? 103n : 99n;
      for (const [hash, tx] of sent) {
        receipts.set(hash, { transactionHash: hash, blockNumber: 100n, blockHash: '0x' + '55'.repeat(32),
          contractAddress: null, status: 'success', gasUsed: 90000n, effectiveGasPrice: 1000000n });
        if (tx.data === '0x1234') resolved = true; else callbackDelivered = deliverCallback;
      }
    } };
}

test('unknown delivery retains its transaction and reservation after restart and revocation', async t => {
  const f = await fixture(t);
  assert.equal((await f.make().step(f.input)).state, 'pending');
  assert.equal((await f.ledger()).reserved, '135000000000');
  await revokeContractDispatchBudget(f.store, f.budget.id);
  assert.equal((await f.make().step({ ...f.input, allowSubmit: false })).state, 'pending');
  f.confirm(true, false);
  assert.equal((await f.make().step({ ...f.input, allowSubmit: false })).state, 'pending');
  assert.equal((await f.ledger()).reserved, '135000000000');
  f.confirm();
  assert.equal((await f.make().step({ ...f.input, allowSubmit: false })).state, 'delivered');
  assert.equal((await f.ledger()).spent, '90000000000'); assert.equal((await f.ledger()).reserved, '0');
  await f.make().step({ ...f.input, allowSubmit: false });
  assert.equal(f.broadcasts(), 1); assert.equal((await f.ledger()).spent, '90000000000');
});

test('authority lost after signing cancels the unsent delivery and returns only its reservation', async t => {
  const f = await fixture(t); f.denyAt(5);
  assert.equal((await f.make().step(f.input)).state, 'closed');
  assert.equal(f.broadcasts(), 0); assert.equal((await f.ledger()).reserved, '0'); assert.equal((await f.ledger()).spent, '0');
});

test('project admission is checked again after signing, while an old broadcast remains reconcilable', async t => {
  const before = await fixture(t); before.withdrawAdmissionAt(3);
  assert.equal((await before.make().step(before.input)).state, 'closed');
  assert.equal(before.broadcasts(), 0);
  assert.equal((await before.ledger()).reserved, '0');
  const after = await fixture(t);
  await after.make().step(after.input); after.withdrawAdmissionAt(1); after.confirm();
  assert.equal((await after.make().step(after.input)).state, 'delivered');
  assert.equal(after.broadcasts(), 1);
  assert.equal((await after.ledger()).spent, '90000000000');
});

test('cumulative gas cap rejects fresh work without consuming the wallet slot', async t => {
  const f = await fixture(t);
  await f.store.transaction(async tx => {
    const row = await tx.read('contract-dispatch-budgets', f.budget.id);
    await tx.write('contract-dispatch-budgets', f.budget.id, { ...row.value, spent: '900000000000' }, row.revision);
  });
  await assert.rejects(f.make().step(f.input), { code: 'dispatch_budget_exhausted' });
  assert.equal(f.broadcasts(), 0); assert.equal((await f.store.list('chain-transactions')).length, 0);
  assert.equal((await f.ledger()).spent, '900000000000');
  await assert.rejects(admitContractDispatchBudget(f.store, { ...f.budget, maximumTotal: '2000000000000' }), { code: 'idempotency_conflict' });
});

test('changed results and mainnet grants cannot reuse an admitted delivery', async t => {
  const f = await fixture(t); await f.make().step(f.input);
  await assert.rejects(f.make().step({ ...f.input, request: { ...f.input.request,
    result: { ...f.input.request.result, decision: 'reject' } } }), { code: 'dispatch_intent_mismatch' });
  await assert.rejects(admitContractDispatchBudget(f.store, { ...f.budget, id: 'mainnet', chainId: 1 }), { code: 'invalid_dispatch_budget' });
  assert.equal(f.broadcasts(), 1);
});

test('failed callback consumes one bounded attempt without repeating completed work', async t => {
  const f = await fixture(t, true);
  await f.make().step(f.input); f.confirm();
  assert.equal((await f.make().step(f.input)).state, 'pending');
  f.confirm(false);
  assert.equal((await f.make().step(f.input)).state, 'failed');
  assert.equal((await f.make().step(f.input)).state, 'failed');
  assert.equal(f.broadcasts(), 2); assert.equal((await f.ledger()).spent, '180000000000');
  assert.equal((await f.ledger()).reserved, '0');
});

test('concurrent workers share one reservation and one broadcast', async t => {
  const f = await fixture(t);
  await Promise.all([f.make().step(f.input), f.make().step(f.input)]);
  assert.equal(f.broadcasts(), 1);
  assert.equal((await f.ledger()).reserved, '135000000000');
  assert.equal((await f.store.list('chain-transactions')).length, 1);
});
