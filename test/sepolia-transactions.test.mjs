import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { keccak256, parseTransaction } from 'viem';
import { openStore } from '../src/storage/index.mjs';
import { createSealer } from '../adapters/secrets.mjs';
import { createSepoliaTransactions } from '../adapters/sepolia-transactions.mjs';

function fixture(t) {
  const store = openStore(':memory:'); t.after(() => store.close());
  const signer = privateKeyToAccount(generatePrivateKey());
  let clock = Date.now();
  let allowed = true, authorityError = null, broadcasts = 0, raw, receipt, wrongChain = false, mismatched = false;
  const client = { getChainId: async () => wrongChain ? 1 : 11155111,
    estimateGas: async () => 100000n, estimateFeesPerGas: async () => ({ maxFeePerGas: 1000000n, maxPriorityFeePerGas: 0n }),
    getTransactionCount: async () => 0, getBalance: async () => 10000000000000000n,
    sendRawTransaction: async ({ serializedTransaction }) => { broadcasts++; raw = serializedTransaction; throw Error('response lost'); },
    getTransactionReceipt: async () => { if (!receipt) throw Error('pending'); return receipt; },
    getBlockNumber: async () => 103n, getBlock: async () => ({ hash: '0x' + '11'.repeat(32) }),
    getTransaction: async () => { const parsed = parseTransaction(raw); return { ...parsed, from: signer.address,
      input: mismatched ? '0x00' : parsed.data, value: parsed.value ?? 0n }; }
  };
  const sealer = createSealer('11'.repeat(32));
  const make = () => createSepoliaTransactions({ store, signer, client, sealer, now: () => clock, authorize: async () => {
    if (authorityError) throw Object.assign(Error(authorityError), { code: authorityError });
    return allowed;
  } });
  const input = id => ({ id, data: '0x60006000', authority: { profile: 'local-test' }, expiresAt: clock + 300000 });
  return { tx: make(), make, client, input, advance: ms => { clock += ms; }, deny: () => { allowed = false; }, allow: () => { allowed = true; }, wrong: () => { wrongChain = true; },
    authorityError: code => { authorityError = code; },
    mismatch: value => { mismatched = value; }, broadcasts: () => broadcasts,
    confirm: () => { receipt = { transactionHash: keccak256(raw), blockNumber: 100n, blockHash: '0x' + '11'.repeat(32),
      contractAddress: '0x' + '22'.repeat(20), status: 'success', gasUsed: 90000n, effectiveGasPrice: 1000000n }; } };
}
test('an uncertain send keeps one hash and the wallet slot across restarts', async t => {
  const f = fixture(t), input = f.input('first');
  const first = await f.tx.prepare(input);
  assert.equal(first.state, 'prepared'); assert.equal('sealedRaw' in first, false);
  assert.deepEqual(await f.tx.prepare(input), first);
  assert.equal((await f.tx.submit('first')).state, 'unknown');
  const restarted = f.make();
  await restarted.submit('first'); await restarted.reconcile('first');
  assert.equal(f.broadcasts(), 1);
  await assert.rejects(restarted.prepare(f.input('second')), { code: 'wallet_busy' });
  f.confirm(); const done = await restarted.reconcile('first'); assert.equal(done.state, 'confirmed');
  assert.equal(done.hash, first.hash);
  assert.equal((await restarted.prepare(f.input('second'))).nonce, 1, 'confirmed nonce survives a lagging RPC');
});
test('revocation after preparation prevents broadcast and releases only the unsent slot', async t => {
  const f = fixture(t); await f.tx.prepare(f.input('first')); f.deny();
  assert.equal((await f.tx.submit('first')).state, 'cancelled'); assert.equal(f.broadcasts(), 0);
});
test('mismatched chain receipt cannot clear the unresolved transaction', async t => {
  const f = fixture(t); await f.tx.prepare(f.input('first')); await f.tx.submit('first'); f.confirm(); f.mismatch(true);
  await assert.rejects(f.tx.reconcile('first'), { code: 'transaction_receipt_mismatch' });
  await assert.rejects(f.tx.prepare(f.input('second')), { code: 'wallet_busy' });
  f.mismatch(false); assert.equal((await f.tx.reconcile('first')).state, 'confirmed');
});
test('explicit authorization errors cancel an unsent intent, while outages keep its slot', async t => {
  const f = fixture(t); await f.tx.prepare(f.input('first'));
  f.authorityError('storage_unavailable');
  await assert.rejects(f.tx.submit('first'), { code: 'storage_unavailable' });
  assert.equal((await f.tx.status('first')).state, 'prepared');
  f.authorityError('scope_denied');
  assert.equal((await f.tx.submit('first')).state, 'cancelled');
  assert.equal(f.broadcasts(), 0);
  f.authorityError(null);
  assert.equal((await f.tx.prepare(f.input('second'))).nonce, 0);
});
test('mainnet and changed intent cannot reuse this executor', async t => {
  const f = fixture(t), input = f.input('first'); await f.tx.prepare(input);
  await assert.rejects(f.tx.prepare({ ...input, data: '0x60016000' }), { code: 'idempotency_conflict' });
  f.wrong(); await assert.rejects(f.tx.submit('first'), { code: 'wrong_chain' }); assert.equal(f.broadcasts(), 0);
});
test('state-creation gas can increase without increasing the monetary ceiling', async t => {
  const f=fixture(t);f.client.estimateGas=async()=>19458943n;
  const prepared=await f.tx.prepare(f.input('large-deployment'));
  assert.equal(prepared.gas,'24333678');assert.equal(prepared.maxFeePerGas,'1000000');
  f.deny();await f.tx.submit('large-deployment');
  f.client.estimateFeesPerGas=async()=>({maxFeePerGas:1000000000n,maxPriorityFeePerGas:0n});
  await assert.rejects(f.tx.prepare(f.input('too-expensive')),{code:'transaction_cost_limit'});
  f.client.estimateFeesPerGas=async()=>({maxFeePerGas:1000000n,maxPriorityFeePerGas:0n});
  f.client.estimateGas=async()=>30000000n;
  await assert.rejects(f.tx.prepare(f.input('too-large')),{code:'transaction_cost_limit'});
});

 test('a lost write resends identical bytes with fresh authority and keeps one reservation', async t => {
  const f=fixture(t), first=await f.tx.prepare(f.input('retry-original'));
  await f.tx.submit('retry-original'); f.advance(60001);
  const retry=await f.make().reconcile('retry-original');
  assert.equal(f.broadcasts(),2);assert.equal(retry.hash,first.hash);assert.equal(retry.nonce,first.nonce);
  f.deny();f.advance(60001);await f.make().reconcile('retry-original');assert.equal(f.broadcasts(),2);
  f.allow(); await assert.rejects(f.tx.prepare(f.input('other')),{code:'wallet_busy'});
  f.confirm();assert.equal((await f.tx.reconcile('retry-original')).state,'confirmed');
 });
