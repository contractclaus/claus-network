import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/storage/index.mjs';
import { createContractIntakeWorker } from '../runtime/contract-intake-worker.mjs';
import { digest } from '../src/shared/index.mjs';

async function fixture(t) {
  const store = openStore(':memory:'); t.after(() => store.close());
  const f = { store, active: true, calls: [], sends: [], fail: null, deliveryState: 'pending', scans: 0, runs: 0 };
  await store.transaction(tx => tx.write('contract-bindings', 'known', { id: 'known' }, 0));
  const events = [{ bindingId: 'unknown', transactionHash: 'unknown', logIndex: 0 },
    { bindingId: 'known', transactionHash: 'known', logIndex: 1 }];
  const chain = { profile: async () => ({ chainId: 11155111, inbox: 'inbox', codeHash: 'pinned' }),
    scan: async cursor => { f.scans++; f.calls.push(cursor); return {
      cursor: { afterBlock: 200, blockHash: 'canonical' }, events: cursor.afterBlock < 200 ? events : [] }; } };
  const request = { id: 'request', projectId: 'project', state: 'result_ready', result: { decision: 'approve' },
    observation: { chainId: 11155111, inbox: 'inbox', codeHash: 'pinned' } };
  const intake = { ingest: async (binding, pointer) => { f.calls.push([binding, pointer]); if (f.fail) throw Object.assign(Error(f.fail), { code: f.fail }); },
    run: async () => { f.runs++; return { state: 'waiting' }; } };
  const delivery = { step: async input => { f.sends.push(input); return { state: f.deliveryState,
    resultHash: f.badHash ? digest('wrong') : digest(input.request.result), finalized: f.finalized ?? true,
    transactionHash: '0x' + '11'.repeat(32), privateCredential: 'must-not-be-stored' }; } };
  f.create = () => createContractIntakeWorker({ store, chain, intake, delivery, startBlock: 100, enabled: () => {
    if (f.admissionError) throw Object.assign(Error(f.admissionError), { code: f.admissionError });
    return f.active;
  } });
  f.worker = f.create();
  f.result = () => store.transaction(tx => tx.write('contract-requests', request.id, request, 0));
  return f;
}

test('scanner ignores unknown bindings and resumes its canonical cursor after restart', async t => {
  const f = await fixture(t);
  assert.equal((await f.worker.tick()).ingested, 1);
  assert.equal((await f.create().tick()).ingested, 0);
  assert.equal(f.calls.filter(Array.isArray).length, 1);
  assert.deepEqual(f.calls[0], { afterBlock: 99, blockHash: null });
  assert.deepEqual(f.calls.at(-1), { afterBlock: 200, blockHash: 'canonical' });
});

test('transient errors retain the cursor while deterministic rejections cannot poison it', async t => {
  const f = await fixture(t); f.fail = 'rpc_unavailable';
  await assert.rejects(f.worker.tick(), { code: 'rpc_unavailable' });
  assert.equal((await f.store.list('contract-intake-cursors')).length, 0);
  f.fail = 'invalid_contract_input'; await f.worker.tick();
  assert.equal((await f.store.list('contract-intake-rejections')).length, 1);
  assert.equal((await f.store.list('contract-intake-cursors')).length, 1);
});

test('pending delivery keeps its identity after restart and revocation permits reconciliation only', async t => {
  const f = await fixture(t); await f.result();
  await f.worker.tick(); f.active = false; f.deliveryState = 'delivered';
  const done = await f.create().tick();
  assert.equal(done.delivered, 1); assert.equal(f.scans, 1); assert.equal(f.runs, 1);
  assert.equal(f.sends[0].id, f.sends[1].id); assert.equal(f.sends[1].allowSubmit, false);
  const receipt = (await f.store.read('contract-requests', 'request')).value.delivery;
  assert.equal(receipt.privateCredential, undefined); assert.equal(receipt.finalized, true);
  await f.create().tick(); assert.equal(f.sends.length, 2);
});

test('a claimed delivery must match the exact result and be finalized', async t => {
  const f = await fixture(t); await f.result(); f.deliveryState = 'delivered'; f.badHash = true;
  await assert.rejects(f.worker.tick(), { code: 'delivery_result_mismatch' });
  f.badHash = false; f.finalized = false;
  await assert.rejects(f.worker.tick(), { code: 'delivery_not_finalized' });
  assert.equal((await f.store.read('contract-requests', 'request')).value.delivery, undefined);
});

test('a replaced or withdrawn host admission still reconciles original broadcasts', async t => {
  for (const code of ['intake_admission_changed', 'intake_review_not_admitted']) {
    const f = await fixture(t); await f.result(); f.admissionError = code;
    f.deliveryState = 'delivered';
    const result = await f.worker.tick();
    assert.equal(result.state, 'disabled'); assert.equal(result.disabledReason, code);
    assert.equal(result.delivered, 1); assert.equal(f.scans, 0); assert.equal(f.runs, 0);
    assert.equal(f.sends[0].allowSubmit, false);
  }
});

test('different inbox generations cannot block or consume one another\'s delivery', async t => {
  const f = await fixture(t); await f.result();
  const current = (await f.store.read('contract-requests', 'request')).value;
  await f.store.transaction(tx => tx.write('contract-requests', 'older', { ...current, id: 'older',
    observation: { ...current.observation, inbox: 'another-inbox' } }, 0));
  await f.worker.tick();
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].request.id, 'request');
  assert.equal((await f.store.read('contract-requests', 'older')).value.delivery, undefined);
});
