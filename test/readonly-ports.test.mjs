import test from 'node:test';
import assert from 'node:assert/strict';
import { readonlyPorts } from '../runtime/readonly-ports.mjs';

function rpcMock(t, respond) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init);
    const body = await request.json();
    const host = new URL(request.url).hostname;
    calls.push(host);
    return respond(host, body);
  });
  return calls;
}
const success = body => Response.json({ jsonrpc: '2.0', id: body.id, result: '0xaa36a7' });

test('Sepolia uses the configured primary and falls back once on provider failure', async t => {
  const calls = rpcMock(t, (host, body) => host === 'rpc.example'
    ? new Response('unavailable', { status: 503 }) : success(body));
  const ports = readonlyPorts({ CLAUS_SEPOLIA_RPC_URL: 'https://rpc.example' });
  assert.equal(await ports.client.getChainId(), 11155111);
  assert.deepEqual(calls, ['rpc.example', 'sepolia.drpc.org']);
  assert.equal(ports.mainnetClient, undefined);
});

test('a healthy Sepolia primary does not call the backup', async t => {
  const calls = rpcMock(t, (_host, body) => success(body));
  assert.equal(await readonlyPorts({}).client.getChainId(), 11155111);
  assert.deepEqual(calls, ['ethereum-sepolia-rpc.publicnode.com']);
});

test('both provider failures remain an error and a dRPC primary has a distinct backup', async t => {
  const calls = rpcMock(t, () => new Response('unavailable', { status: 503 }));
  await assert.rejects(readonlyPorts({ CLAUS_SEPOLIA_RPC_URL: 'https://sepolia.drpc.org' }).client.getChainId());
  assert.deepEqual(calls, ['sepolia.drpc.org', 'ethereum-sepolia-rpc.publicnode.com']);
});

test('a contract revert is not retried through another provider', async t => {
  const calls = rpcMock(t, (_host, body) => Response.json({ jsonrpc: '2.0', id: body.id,
    error: { code: 3, message: 'execution reverted' } }));
  await assert.rejects(readonlyPorts({}).client.request({ method: 'eth_call', params: [{
    to: '0x0000000000000000000000000000000000000001', data: '0x12345678'
  }, 'latest'] }));
  assert.equal(calls.length, 1);
});
