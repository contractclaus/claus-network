import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { keccak256, parseTransaction } from 'viem';
import { openStore } from '../src/storage/index.mjs';
import { digest } from '../src/shared/index.mjs';
import { createSealer } from '../adapters/secrets.mjs';
import { admitContractDispatchBudget, revokeContractDispatchBudget, createContractDelivery } from '../adapters/contract-delivery.mjs';

async function fixture(t, callback = false, publicAdmission = false) {
  const store = openStore(':memory:'); t.after(() => store.close());
  const signer = privateKeyToAccount(generatePrivateKey());
  const inbox = '0x' + '22'.repeat(20), codeHash = '0x' + '33'.repeat(32);
  let now = Date.now();
  const budget = { id: 'fixture-budget', chainId: 11155111, dispatcher: signer.address.toLowerCase(), inbox,
    codeHash, projectIds: ['project-a'], expiresAt: now + 86400000, maximumTotal: '1000000000000',
    maximumTransaction: '200000000000', maximumGas: '1000000', maximumFeePerGas: '1000000' };
  if (publicAdmission) { budget.projectIds = []; budget.admissionMode = 'public-readonly-v1'; budget.maximumProject = '300000000000'; }
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
  const make = (selectedBudget = budget) => createContractDelivery({ store, client, signer, sealer: createSealer('11'.repeat(32)), chain, identity, budget: selectedBudget,
    admitted: async (_reader, projectId) => ['project-a', 'project-b'].includes(projectId) && ++admissionChecks < withdrawAdmissionAt, now: () => now });
  const input = { id: digest({ requestId: request.id, action: 'result-delivery' }), request, allowSubmit: true };
  return { store, budget, make, input, client, chain, advanceTo: time => { now = time; }, broadcasts: () => broadcasts, denyAt: n => { identityChecks = 0; denyAt = n; },
    externalCallback: () => { callbackDelivered = true; },
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
  assert.equal((await f.make().step(f.input)).state, 'failed');
  assert.equal(f.broadcasts(), 0); assert.equal((await f.ledger()).reserved, '0'); assert.equal((await f.ledger()).spent, '0');
});

test('an already revoked project is skipped without failing the shared delivery worker', async t => {
  const f = await fixture(t); f.denyAt(1);
  assert.equal((await f.make().step(f.input)).state, 'pending');
  assert.equal(f.broadcasts(), 0);
  assert.equal((await f.ledger()).reserved, '0');
  assert.equal((await f.store.list('chain-transactions')).length, 0);
});

test('project admission is checked again after signing, while an old broadcast remains reconcilable', async t => {
  const before = await fixture(t); before.withdrawAdmissionAt(3);
  assert.equal((await before.make().step(before.input)).state, 'failed');
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

test('a finalized external callback completes the original result without spending or inventing a receipt', async t => {
  const f = await fixture(t, true);
  await f.make().step(f.input); f.confirm(); f.externalCallback();
  const rows = await f.store.list('chain-transactions');
  assert.equal(rows.length, 1);
  const result = await f.make().step({ ...f.input, allowSubmit: false });
  assert.equal(result.state, 'delivered');
  assert.equal(result.transactionHash, rows[0].value.hash);
  assert.equal(f.broadcasts(), 1);
  assert.equal((await f.ledger()).spent, '90000000000');
  assert.equal((await f.ledger()).reserved, '0');
});

test('concurrent workers share one reservation and one broadcast', async t => {
  const f = await fixture(t);
  await Promise.all([f.make().step(f.input), f.make().step(f.input)]);
  assert.equal(f.broadcasts(), 1);
  assert.equal((await f.ledger()).reserved, '135000000000');
  assert.equal((await f.store.list('chain-transactions')).length, 1);
});

test('public callback budget uses current project admission without an operator-maintained project list', async t => {
  const allowed = await fixture(t, true, true);
  await allowed.make().step(allowed.input); allowed.confirm();
  await allowed.make().step(allowed.input); allowed.confirm();
  assert.equal((await allowed.make().step(allowed.input)).state, 'delivered');
  assert.equal(allowed.broadcasts(), 2);
  assert.equal((await allowed.ledger()).spent, '180000000000');
  const revoked = await fixture(t, false, true); revoked.withdrawAdmissionAt(3);
  assert.equal((await revoked.make().step(revoked.input)).state, 'failed');
  assert.equal(revoked.broadcasts(), 0);
  assert.equal((await revoked.ledger()).reserved, '0');
  await assert.rejects(admitContractDispatchBudget(revoked.store, {...revoked.budget, id:'invalid-mode', admissionMode:'all'}), {code:'invalid_dispatch_budget'});
  await assert.rejects(admitContractDispatchBudget(revoked.store, {...revoked.budget, id:'ambiguous', projectIds:['project-a']}), {code:'invalid_dispatch_budget'});
  await assert.rejects(admitContractDispatchBudget(revoked.store, {...revoked.budget, id:'inconsistent-share', maximumProject:'100000000000'}), {code:'invalid_dispatch_budget'});
});

test('selecting a new public budget reconciles a pending old transaction against its original ledger', async t => {
  const f = await fixture(t);
  await f.make().step(f.input);
  const next = {...f.budget, id:'public-next', maximumProject:'300000000000', admissionMode:'public-readonly-v1', projectIds:[]};
  await admitContractDispatchBudget(f.store, next);
  await revokeContractDispatchBudget(f.store, f.budget.id);
  f.confirm();
  assert.equal((await f.make(next).step({...f.input,allowSubmit:false})).state,'delivered');
  assert.equal((await f.ledger()).spent,'90000000000');
  assert.equal((await f.ledger()).reserved,'0');
  const fresh=(await f.store.read('contract-dispatch-budgets',next.id)).value;
  assert.equal(fresh.spent,'0');assert.equal(fresh.reserved,'0');assert.equal(f.broadcasts(),1);
});


test('public dispatcher enforces each project share and makes chain reads outside write transactions', async t => {
  const f = await fixture(t, false, true);
  const transaction = f.store.transaction.bind(f.store), read = f.chain.deliveryState;
  let writing = false;
  f.store.transaction = work => transaction(async tx => { writing = true; try { return await work(tx); } finally { writing = false; } });
  f.chain.deliveryState = async (...args) => { assert.equal(writing, false, 'RPC must not hold the database write lock'); return read(...args); };
  await f.store.transaction(tx => tx.write('contract-dispatch-projects', digest({ budgetId: f.budget.id, projectId: 'project-a' }),
    { spent: f.budget.maximumProject, reserved: '0' }, 0));
  await assert.rejects(f.make().step(f.input), { code: 'dispatch_project_budget_exhausted' });
  assert.equal(f.broadcasts(), 0); assert.equal((await f.ledger()).reserved, '0');
  const request = { ...f.input.request, id: digest('project-b-request'), projectId: 'project-b', bindingId: 'binding-b' };
  await f.store.transaction(async tx => {
    await tx.write('contract-requests', request.id, request, 0);
    const binding = (await tx.read('contract-bindings', 'binding-a')).value;
    await tx.write('contract-bindings', 'binding-b', { ...binding, projectId: 'project-b' }, 0);
  });
  const next = { ...f.input, id: digest({ requestId: request.id, action: 'result-delivery' }), request };
  assert.equal((await f.make().step(next)).state, 'pending');
  assert.equal(f.broadcasts(), 1); f.confirm();
  assert.equal((await f.make().step(next)).state, 'delivered');
  const usage = (await f.store.read('contract-dispatch-projects', digest({ budgetId: f.budget.id, projectId: 'project-b' }))).value;
  assert.equal(usage.spent, '90000000000'); assert.equal(usage.reserved, '0');
});

test('an expired subsidy stops sponsorship without declaring the onchain request closed', async t => {
  const f = await fixture(t);
  f.input.request.observation.deadline = Math.floor(f.budget.expiresAt / 1000) + 3600;
  f.advanceTo(f.budget.expiresAt + 1);
  const stopped = await f.make().step(f.input);
  assert.equal(stopped.state, 'failed');
  assert.equal(stopped.reason, 'dispatch_subsidy_expired');
  assert.equal(f.broadcasts(), 0);
  assert.equal((await f.store.list('chain-transactions')).length, 0);
  f.advanceTo(f.input.request.observation.deadline * 1000 + 1);
  assert.equal((await f.make().step(f.input)).state, 'closed');
});

test('an external callback seen after local cancellation waits for finality', async t => {
  const f = await fixture(t, true);
  await f.make().step(f.input); f.confirm();
  const state = f.chain.deliveryState;
  f.denyAt(5);
  let reads = 0, final = false;
  f.chain.deliveryState = async (request, tag) => {
    const value = await state(request, tag);
    // The external callback races the final authorization check after signing.
    return { ...value, callbackDelivered: tag === 'finalized' ? final : ++reads >= 4 };
  };
  assert.equal((await f.make().step(f.input)).state, 'pending');
  const rows = await f.store.list('chain-transactions');
  assert.equal(rows.find(x => x.id.endsWith(':callback')).value.state, 'cancelled');
  assert.equal(f.broadcasts(), 1);
  final = true;
  assert.equal((await f.make().step(f.input)).state, 'delivered');
  assert.equal(f.broadcasts(), 1);
  assert.equal((await f.ledger()).reserved, '0');
});

test('subsidy expiry cancels a prepared unsent transaction without marking its open request closed', async t => {
  const f = await fixture(t);
  f.input.request.observation.deadline = Math.floor(f.budget.expiresAt / 1000) + 3600;
  f.input.request.observationHash = digest(f.input.request.observation);
  const row = await f.store.read('contract-requests', f.input.request.id);
  await f.store.transaction(tx => tx.write('contract-requests', f.input.request.id, f.input.request, row.revision));
  let calls = 0;
  f.client.getChainId = async () => { if (++calls === 2) throw Error('RPC unavailable after prepare'); return 11155111; };
  await assert.rejects(f.make().step(f.input), /RPC unavailable after prepare/);
  assert.equal((await f.store.list('chain-transactions'))[0].value.state, 'prepared');
  f.advanceTo(f.budget.expiresAt + 1);
  const result = await f.make().step(f.input);
  assert.equal(result.state, 'failed'); assert.equal(result.reason, 'dispatch_cancelled');
  assert.equal((await f.store.list('chain-transactions'))[0].value.state, 'cancelled');
  assert.equal((await f.ledger()).reserved, '0'); assert.equal(f.broadcasts(), 0);
});

test('a resolved request with expired callback funding has a final delivery failure and no replacement spend', async t => {
  const f = await fixture(t, true);
  await f.make().step(f.input); f.confirm(); f.advanceTo(f.budget.expiresAt + 1);
  const result = await f.make().step(f.input);
  assert.equal(result.state, 'failed'); assert.equal(result.reason, 'dispatch_subsidy_expired');
  const next = { ...f.budget, id: 'later-explicit-allocation', expiresAt: f.budget.expiresAt + 86400000 };
  await admitContractDispatchBudget(f.store, next);
  assert.equal((await f.make(next).step(f.input)).state, 'failed');
  assert.equal((await f.store.read('contract-dispatch-budgets', next.id)).value.reserved, '0');
  assert.equal(f.broadcasts(), 1); assert.equal((await f.store.list('chain-transactions')).length, 1);
});
