import test from 'node:test';
import assert from 'node:assert/strict';
import { executeData, executeReport, definitions, createReferenceWorker } from '../reference/providers.mjs';
import { schemaDefinition, schemaValue } from '../src/services/schema.mjs';
import { ROUTES, validate } from '../interfaces/contract.mjs';
const address = '0x' + '12'.repeat(20), hash = '0x' + 'ab'.repeat(32);
function transport({ chain = '0xaa36a7', changed = false } = {}) {
  let blocks = 0;
  return async (url, options) => {
    assert.equal(url, 'https://ethereum-sepolia-rpc.publicnode.com');
    const { method, params } = JSON.parse(options.body);
    let result;
    if (method === 'eth_chainId') result = chain;
    else if (method === 'eth_getBlockByNumber') result = { number: '0x100', hash: changed && blocks++ ? '0x' + 'cd'.repeat(32) : hash };
    else { assert.equal(method, 'eth_getBalance'); assert.deepEqual(params, [address, '0x100']); result = '0xde0b6b3a7640000'; }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  };
}
test('reference data pins a finalized block and rejects a changed block or wrong chain', async () => {
  for (const definition of Object.values(definitions)) { schemaDefinition(definition.inputSchema); schemaDefinition(definition.outputSchema); }
  const output = await executeData({ address }, { request: transport(), now: () => 100 });
  schemaValue(definitions.data.outputSchema, output);
  assert.equal(output.balanceWei, '1000000000000000000'); assert.equal(output.blockHash, hash);
  await assert.rejects(executeData({ address }, { request: transport({ chain: '0x1' }) }), /chain_mismatch/);
  await assert.rejects(executeData({ address }, { request: transport({ changed: true }) }), /block_changed/);
  const never = () => { throw Error('unexpected_request'); };
  assert.equal((await executeData({ address: '<script>' }, { request: never })).status, 'error');
  assert.equal((await executeData({}, { purpose: 'conformance', request: never })).status, 'probe');
});
test('report emits only validated data and never labels a conformance probe as an observation', async () => {
  const balance = await executeData({ address }, { request: transport() });
  const output = executeReport({ balance }); schemaValue(definitions.report.outputSchema, output);
  assert.equal(output.status, 'ok'); assert.match(output.html, /1\.000000000000000000 ETH/);
  assert.equal(executeReport({ balance: { ...balance, address: '</dd><script>alert(1)</script>' } }).status, 'error');
  assert.equal(executeReport({ balance }, { purpose: 'conformance' }).html, '');
  assert.equal(executeReport({ balance: { ...balance, status: 'probe' } }).status, 'error');
});
test('a reference worker paginates, respects leases and delivers only its configured service', async () => {
  const calls = [];
  const client = { async call(name, args) {
    validate(ROUTES.find(route => route.name === name).inputSchema, args);
    calls.push(name);
    if (name === 'provider_orders') return args.after ? { orders: [{ id: 'mine', serviceId: 'service' }], nextCursor: null } :
      { orders: [{ id: 'other', serviceId: 'another' }, { id: 'busy', serviceId: 'service', leaseUntil: 999 }], nextCursor: 'next' };
    if (name === 'provider_claim') { assert.equal(args.orderId, 'mine'); return { state: 'working', lease: 'one', purpose: 'conformance', input: {} }; }
    assert.equal(name, 'provider_deliver'); assert.equal(args.output.status, 'probe'); assert.equal(args.lease, 'one');
  } };
  assert.deepEqual(await createReferenceWorker({ role: 'data', client, projectId: 'project', serviceId: 'service', now: () => 1 }).tick(), { state: 'ready', delivered: 1 });
  assert.deepEqual(calls, ['provider_orders', 'provider_orders', 'provider_claim', 'provider_deliver']);
});
