import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbi } from 'viem';
import { eip3009ABI, PERMIT2_ADDRESS, x402UptoPermit2ProxyAddress, x402UptoPermit2ProxyABI } from '@x402/evm';
import { USDC as usdc } from '../adapters/surplus-x402.mjs';
import { verifySettlementCost } from '../adapters/surplus-settlement.mjs';

const payer = '0x1111111111111111111111111111111111111111';
const payTo = '0x2222222222222222222222222222222222222222';
const facilitator = '0x3333333333333333333333333333333333333333';
const other = '0x4444444444444444444444444444444444444444';
const hash = digit => `0x${digit.repeat(64)}`;
const txHash = hash('a'), blockHash = hash('b'), safeHash = hash('c');
// Opaque fixture bytes only: no key, signing, client creation, or network transport.
const sig = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;
const exactAbi = [...eip3009ABI, ...eip3009ABI.filter(x => x.name === 'transferWithAuthorization').map(x => ({ ...x, name: 'receiveWithAuthorization' }))];
const eventAbi = parseAbi([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
  'event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)',
  'event AuthorizationCanceled(address indexed authorizer,bytes32 indexed nonce)',
  'event Settled()',
  'event SettledWithPermit()',
]);
function event(name, args, address, logIndex) {
  return { address, logIndex, removed: false, transactionHash: txHash, blockHash, blockNumber: 90n,
    topics: encodeEventTopics({ abi: eventAbi, eventName: name, args }),
    data: ['Transfer', 'Approval'].includes(name) ? encodeAbiParameters([{ type: 'uint256' }], [args.value]) : '0x' };
}

function fixture(scheme = 'exact', { bytes = false, receive = false, withPermit = false, amount = 1350n } = {}) {
  const accepted = { scheme, network: 'eip155:8453', asset: usdc, amount: '100000', payTo,
    extra: { name: 'USD Coin', version: '2', assetTransferMethod: scheme === 'exact' ? 'eip3009' : 'permit2', facilitatorAddress: facilitator } };
  const a = scheme === 'exact'
    ? { from: payer, to: payTo, value: '100000', nonce: hash('d'), validAfter: '100', validBefore: '200' }
    : { from: payer, permitted: { token: usdc, amount: '100000' }, spender: x402UptoPermit2ProxyAddress,
      nonce: '513', deadline: '200', witness: { to: payTo, facilitator, validAfter: '100' } };
  const payment = { x402Version: 2, accepted, payload: { [scheme === 'exact' ? 'authorization' : 'permit2Authorization']: a, signature: sig } };
  const receipt = { success: true, network: 'eip155:8453', payer, transaction: txHash };
  const actual = scheme === 'exact' ? 100000n : amount;
  const target = scheme === 'exact' ? usdc : x402UptoPermit2ProxyAddress;
  const functionName = scheme === 'exact' ? receive ? 'receiveWithAuthorization' : 'transferWithAuthorization' : withPermit ? 'settleWithPermit' : 'settle';
  const args = scheme === 'exact'
    ? [payer, payTo, 100000n, 100n, 200n, a.nonce, ...(bytes ? [sig] : [27, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`])]
    : [...(withPermit ? [{ value: 100000n, deadline: 200n, r: hash('1'), s: hash('2'), v: 27 }] : []),
      { permitted: { token: usdc, amount: 100000n }, nonce: 513n, deadline: 200n }, actual, payer, { ...a.witness, validAfter: 100n }, sig];
  const tx = { hash: txHash, to: target, from: facilitator, value: 0n, chainId: 8453, blockHash, blockNumber: 90n, input: '' };
  const mined = { transactionHash: txHash, status: 'success', blockNumber: 90n, blockHash, from: facilitator, to: target,
    logs: [event('Transfer', { from: payer, to: payTo, value: actual }, usdc, 0),
      scheme === 'exact' ? event('AuthorizationUsed', { authorizer: payer, nonce: a.nonce }, usdc, 1)
        : event(withPermit ? 'SettledWithPermit' : 'Settled', {}, target, 1)] };
  if (receive) tx.from = mined.from = payTo;
  if (withPermit) mined.logs.push(event('Approval', { owner: payer, spender: PERMIT2_ADDRESS, value: 100000n }, usdc, 2));
  const safe = { number: 100n, hash: safeHash, timestamp: 180n }, canonical = { number: 90n, hash: blockHash, timestamp: 150n };
  const calls = [];
  const chain = {
    getChainId: async () => { calls.push(['getChainId']); return 8453; },
    getBlock: async r => { calls.push(['getBlock', r]);
      if (r.blockTag) { assert.equal(r.blockTag, 'safe'); return safe; }
      assert.ok([90n, 100n].includes(r.blockNumber)); return r.blockNumber === 100n ? safe : canonical; },
    getTransactionReceipt: async r => { calls.push(['getTransactionReceipt', r]); assert.equal(r.hash, txHash); return mined; },
    getTransaction: async r => { calls.push(['getTransaction', r]); assert.equal(r.hash, txHash); return tx; },
    readContract: async r => { calls.push(['readContract', r]); assert.equal(r.blockNumber, 100n);
      assert.equal(r.address, scheme === 'exact' ? usdc : PERMIT2_ADDRESS);
      assert.equal(r.functionName, scheme === 'exact' ? 'authorizationState' : 'nonceBitmap');
      assert.deepEqual(r.args, scheme === 'exact' ? [payer, a.nonce] : [payer, 2n]);
      return scheme === 'exact' ? true : 2n; },
  };
  const recode = () => { tx.input = encodeFunctionData({ abi: scheme === 'exact' ? exactAbi : x402UptoPermit2ProxyABI, functionName, args }); };
  recode();
  return { payment, receipt, chain, tx, mined, safe, canonical, calls, a, args, recode, run: () => verifySettlementCost(payment, receipt, chain, payer) };
}

for (const [name, scheme, options] of [
  ['exact r/v/s', 'exact', {}], ['exact bytes', 'exact', { bytes: true }],
  ['exact receive authorization', 'exact', { receive: true }],
  ['upto direct settle', 'upto', {}], ['upto settleWithPermit', 'upto', { withPermit: true }],
  ['upto zero settlement with explicit transfer evidence', 'upto', { amount: 0n }],
]) test(`valid ${name} returns the chain amount and safe proof without waiting for expiry`, async () => {
  const f = fixture(scheme, options);
  const before = structuredClone(f.payment);
  const result = await f.run();
  assert.equal(result?.amount, scheme === 'exact' ? '100000' : String(options.amount ?? 1350n));
  assert.equal(result.proof.authorizedMicroUsdc, '100000');
  assert.equal(result.proof.confirmation, 'safe');
  assert.equal(result.proof.transaction, txHash);
  assert.equal(result.proof.transactionBlockHash, blockHash);
  assert.equal(result.proof.blockHash, safeHash);
  assert.equal(result.proof.payer, payer);
  assert.equal(result.proof.payTo, payTo);
  assert.equal(result.proof.asset, usdc);
  assert.equal(result.proof.signatureHash, keccak256(sig));
  assert.ok(!JSON.stringify(result).includes(sig));
  assert.deepEqual(f.payment, before);
  assert.equal(f.calls.length, 8);
});

test('buyer telemetry, a claimed amount and a bare successful receipt cannot release reservations', async () => {
  const f = fixture();
  for (const receipt of [null, {}, { success: true }, { 'x-si-buyer-cost-micro': '0' },
    { success: true, network: 'eip155:8453', payer, amount: '0' }]) {
    assert.equal(await verifySettlementCost(f.payment, receipt, f.chain, payer), null);
  }
  assert.equal(f.calls.length, 0);
  Object.assign(f.receipt, { amount: '0', settledMicroUsdc: '1', telemetry: { 'x-si-buyer-cost-micro': '1' } });
  assert.equal((await f.run()).amount, '100000');
  const u = fixture('upto');
  u.receipt['x-si-buyer-cost-micro'] = '0';
  assert.equal((await u.run()).amount, '1350');
});

const malformed = [
  ['missing payment', f => { f.payment.payload = undefined; }],
  ['wrong payment version', f => { f.payment.x402Version = 1; }],
  ['wrong scheme', f => { f.payment.accepted.scheme = 'batch-settlement'; }],
  ['wrong network', f => { f.payment.accepted.network = 'eip155:1'; }],
  ['wrong token', f => { f.payment.accepted.asset = other; }],
  ['wrong payTo', f => { f.payment.accepted.payTo = other; }],
  ['zero recipient', f => { f.payment.accepted.payTo = '0x' + '0'.repeat(40); }],
  ['wrong authorization payer', f => { f.a.from = other; }],
  ['wrong authorization maximum', f => { f.payment.accepted.amount = '99999'; }],
  ['float amount', f => { f.payment.accepted.amount = '1.1'; }],
  ['numeric amount', f => { f.payment.accepted.amount = 100000; }],
  ['zero amount', f => { f.payment.accepted.amount = '0'; }],
  ['oversized integer', f => { f.payment.accepted.amount = '9'.repeat(79); }],
  ['uint256 overflow', f => { f.payment.accepted.amount = String(2n ** 256n); }],
  ['missing signature', f => { delete f.payment.payload.signature; }],
  ['oversized signature', f => { f.payment.payload.signature = '0x' + '11'.repeat(4097); }],
  ['failed facilitator receipt', f => { f.receipt.success = false; }],
  ['nonboolean receipt success', f => { f.receipt.success = 'true'; }],
  ['wrong receipt network', f => { f.receipt.network = 'eip155:1'; }],
  ['wrong receipt payer', f => { f.receipt.payer = other; }],
  ['missing receipt payer', f => { delete f.receipt.payer; }],
  ['malformed receipt transaction', f => { f.receipt.transaction = '0xtx'; }],
];
for (const scheme of ['exact', 'upto']) for (const [name, alter] of malformed)
  test(`${scheme} refuses ${name} before RPC`, async () => {
    const f = fixture(scheme); alter(f); assert.equal(await f.run(), null); assert.equal(f.calls.length, 0);
  });

for (const [scheme, name, alter] of [
  ['exact', 'malformed nonce', f => { f.a.nonce = '1'; }],
  ['exact', 'wrong transfer method', f => { f.payment.accepted.extra.assetTransferMethod = 'permit2'; }],
  ['exact', 'invalid lifetime', f => { f.a.validAfter = '200'; }],
  ['upto', 'negative nonce', f => { f.a.nonce = '-1'; }],
  ['upto', 'overflow nonce', f => { f.a.nonce = String(2n ** 256n); }],
  ['upto', 'wrong proxy', f => { f.a.spender = other; }],
  ['upto', 'wrong permitted token', f => { f.a.permitted.token = other; }],
  ['upto', 'wrong witness recipient', f => { f.a.witness.to = other; }],
  ['upto', 'wrong witness facilitator', f => { f.a.witness.facilitator = other; }],
  ['upto', 'zero witness facilitator', f => { f.a.witness.facilitator = '0x' + '0'.repeat(40); }],
  ['upto', 'missing witness', f => { delete f.a.witness; }],
  ['upto', 'invalid deadline', f => { f.a.deadline = '100'; }],
  ['upto', 'wrong transfer method', f => { f.payment.accepted.extra.assetTransferMethod = 'eip3009'; }],
]) test(`${scheme} refuses ${name} before RPC`, async () => {
  const f = fixture(scheme); alter(f); assert.equal(await f.run(), null); assert.equal(f.calls.length, 0);
});

const evidenceFailures = [
  ['wrong chain', f => { f.chain.getChainId = async () => 1; }],
  ['safe state unavailable', f => { f.chain.getBlock = async () => { throw Error('unsupported safe'); }; }],
  ['malformed safe hash', f => { f.safe.hash = '0xblock'; }],
  ['missing receipt', f => { f.chain.getTransactionReceipt = async () => null; }],
  ['reverted receipt', f => { f.mined.status = 'reverted'; }],
  ['unsafe inclusion', f => { f.safe.number = 89n; }],
  ['wrong transaction receipt hash', f => { f.mined.transactionHash = hash('e'); }],
  ['wrong transaction hash', f => { f.tx.hash = hash('e'); }],
  ['wrong transaction block hash', f => { f.tx.blockHash = hash('e'); }],
  ['wrong transaction block number', f => { f.tx.blockNumber = 91n; }],
  ['wrong transaction chain', f => { f.tx.chainId = 1; }],
  ['wrong transaction sender', f => { f.tx.from = other; }],
  ['wrong transaction receipt recipient', f => { f.mined.to = other; }],
  ['native payment attached', f => { f.tx.value = 1n; }],
  ['wrapped settlement', f => { f.tx.to = other; f.mined.to = other; }],
  ['malformed calldata', f => { f.tx.input = '0x1234'; }],
  ['oversized calldata', f => { f.tx.input = '0x' + '11'.repeat(16385); }],
  ['trailing calldata', f => { f.tx.input += '00'; }],
  ['reorged inclusion', f => { f.canonical.hash = hash('e'); }],
  ['wrong canonical block number', f => { f.canonical.number = 89n; }],
  ['settlement before validAfter', f => { f.canonical.timestamp = 99n; }],
  ['settlement after deadline', f => { f.canonical.timestamp = 201n; f.safe.timestamp = 210n; }],
  ['canonical time newer than safe', f => { f.safe.timestamp = 149n; }],
  ['missing transfer', f => { f.mined.logs.shift(); }],
  ['missing authorization event', f => { f.mined.logs.pop(); }],
  ['wrong transfer payer', f => { f.mined.logs[0] = event('Transfer', { from: other, to: payTo, value: 1350n }, usdc, 0); }],
  ['wrong transfer recipient', f => { f.mined.logs[0] = event('Transfer', { from: payer, to: other, value: 1350n }, usdc, 0); }],
  ['wrong transfer token', f => { f.mined.logs[0].address = other; }],
  ['wrong transfer amount', f => { f.mined.logs[0].data = encodeAbiParameters([{ type: 'uint256' }], [1n]); }],
  ['removed transfer', f => { f.mined.logs[0].removed = true; }],
  ['wrong log transaction', f => { f.mined.logs[0].transactionHash = hash('e'); }],
  ['wrong log block hash', f => { f.mined.logs[0].blockHash = hash('e'); }],
  ['wrong log block number', f => { f.mined.logs[0].blockNumber = 89n; }],
  ['missing log metadata', f => { delete f.mined.logs[0].removed; }],
  ['duplicate log index', f => { f.mined.logs[1].logIndex = 0; }],
  ['partial event topics', f => { f.mined.logs[0].topics.pop(); }],
  ['partial event data', f => { f.mined.logs[0].data = '0x'; }],
  ['trailing event data', f => { f.mined.logs[0].data += '00'; }],
  ['malformed other-token transfer', f => { f.mined.logs.push({ ...f.mined.logs[0], address: other, logIndex: 2, data: '0x' }); }],
  ['batched matching transfer', f => { f.mined.logs.push({ ...f.mined.logs[0], logIndex: 2 }); }],
  ['batched unrelated transfer', f => { f.mined.logs.push(event('Transfer', { from: other, to: facilitator, value: 1n }, other, 2)); }],
  ['too many logs', f => { f.mined.logs = Array(65).fill(f.mined.logs[0]); }],
  ['missing nonce consumption', f => { f.chain.readContract = async () => f.payment.accepted.scheme === 'exact' ? false : 0n; }],
  ['invalid nonce state', f => { f.chain.readContract = async () => 'garbage'; }],
];
for (const scheme of ['exact', 'upto']) for (const [name, alter] of evidenceFailures)
  test(`${scheme} retains reservation for ${name}`, async () => {
    const f = fixture(scheme); alter(f); assert.equal(await f.run(), null); assert.ok(f.calls.length <= 8);
  });

for (const [name, index, replacement] of [
  ['payer', 0, other], ['recipient', 1, other], ['amount', 2, 99999n], ['validAfter', 3, 101n],
  ['validBefore', 4, 201n], ['nonce', 5, hash('e')], ['signature v', 6, 28],
  ['signature r', 7, hash('e')], ['signature s', 8, hash('e')],
]) test(`exact calldata must match original ${name}`, async () => {
  const f = fixture(); f.args[index] = replacement; f.recode(); assert.equal(await f.run(), null);
});
test('exact authorization event must match payer and nonce and cannot be cancellation', async () => {
  for (const log of [event('AuthorizationUsed', { authorizer: payer, nonce: hash('e') }, usdc, 1),
    event('AuthorizationUsed', { authorizer: other, nonce: hash('d') }, usdc, 1),
    event('AuthorizationCanceled', { authorizer: payer, nonce: hash('d') }, usdc, 1)]) {
    const f = fixture(); f.mined.logs[1] = log; assert.equal(await f.run(), null);
  }
});
for (const [name, alter] of [
  ['permitted token', args => { args[0].permitted.token = other; }],
  ['permitted maximum', args => { args[0].permitted.amount = 99999n; }],
  ['nonce', args => { args[0].nonce = 514n; }],
  ['deadline', args => { args[0].deadline = 201n; }],
  ['settled amount', args => { args[1] = 1349n; }],
  ['over-cap amount', args => { args[1] = 100001n; }],
  ['owner', args => { args[2] = other; }],
  ['witness destination', args => { args[3].to = other; }],
  ['witness facilitator', args => { args[3].facilitator = other; }],
  ['witness validAfter', args => { args[3].validAfter = 101n; }],
  ['signature', args => { args[4] = '0xabcd'; }],
]) test(`upto calldata must match original ${name}`, async () => {
  const f = fixture('upto'); alter(f.args); f.recode(); assert.equal(await f.run(), null);
});
test('upto over-cap transfer, a different bitmap bit or a spurious proxy event cannot prove settlement', async () => {
  const over = fixture('upto', { amount: 100001n }); assert.equal(await over.run(), null);
  const bit = fixture('upto'); bit.chain.readContract = async () => 1n; assert.equal(await bit.run(), null);
  const log = fixture('upto'); log.mined.logs[1].address = other; assert.equal(await log.run(), null);
  const method = fixture('upto'); method.mined.logs[1] = event('SettledWithPermit', {}, x402UptoPermit2ProxyAddress, 1);
  assert.equal(await method.run(), null);
});

for (const scheme of ['exact', 'upto']) test(`${scheme} remains bound to original inputs across awaits`, async () => {
  const f = fixture(scheme);
  f.chain.getChainId = async () => {
    f.payment.accepted.payTo = other;
    f.payment.accepted.scheme = 'other';
    f.payment.payload.signature = '0xabcd';
    f.a.from = other;
    f.a.nonce = scheme === 'exact' ? hash('e') : '514';
    if (scheme === 'upto') { f.a.permitted.amount = '1'; f.a.witness.to = other; }
    f.receipt.transaction = hash('e');
    return 8453;
  };
  f.chain.readContract = async r => {
    assert.deepEqual(r.args, scheme === 'exact' ? [payer, hash('d')] : [payer, 2n]);
    return scheme === 'exact' ? true : 2n;
  };
  const result = await f.run();
  assert.equal(result?.amount, scheme === 'exact' ? '100000' : '1350');
  assert.equal(result.proof.transaction, txHash);
  assert.equal(result.proof.payer, payer);
  assert.equal(result.proof.payTo, payTo);
  assert.equal(result.proof.signatureHash, keccak256(sig));
});

test('exact strict authorization time bounds and receive sender identity remain enforced', async () => {
  for (const timestamp of [100n, 200n]) {
    const f = fixture(); f.canonical.timestamp = timestamp; f.safe.timestamp = 210n;
    assert.equal(await f.run(), null);
  }
  const f = fixture('exact', { receive: true }); f.tx.from = f.mined.from = facilitator;
  assert.equal(await f.run(), null);
});

for (const scheme of ['exact', 'upto']) for (const target of ['inclusion', 'anchor'])
  test(`${scheme} rechecks ${target} and refuses a reorg during verification`, async () => {
    const f = fixture(scheme), original = f.chain.getBlock;
    let inclusions = 0;
    f.chain.getBlock = async r => {
      const b = await original(r);
      if ((target === 'inclusion' && r.blockNumber === 90n && ++inclusions === 2)
        || (target === 'anchor' && r.blockNumber === 100n)) return { ...b, hash: hash('e') };
      return b;
    };
    assert.equal(await f.run(), null); assert.ok(f.calls.length <= 8);
  });
for (const method of ['getChainId', 'getBlock', 'getTransactionReceipt', 'getTransaction', 'readContract'])
  test(`RPC ${method} failure conservatively returns null without retry`, async () => {
    const f = fixture('upto'); let attempts = 0;
    f.chain[method] = async () => { attempts++; throw Error('unavailable'); };
    assert.equal(await f.run(), null); assert.equal(attempts, 1);
  });
test('missing client, malformed inputs and wrong explicit payer fail closed', async () => {
  const f = fixture();
  for (const p of [null, undefined, {}, 'bad', []]) assert.equal(await verifySettlementCost(p, f.receipt, f.chain, payer), null);
  for (const expected of [undefined, null, 'invalid', other]) assert.equal(await verifySettlementCost(f.payment, f.receipt, f.chain, expected), null);
  assert.equal(await verifySettlementCost(f.payment, f.receipt, null, payer), null);
  assert.equal(f.calls.length, 0);
});
