import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'viem';
import { createChainRead } from '../adapters/chain-read.mjs';
import { createHttp } from '../interfaces/http.mjs';
import { ROUTES } from '../interfaces/contract.mjs';

function registration(minimum) {
  const code = '0x60006000', codeHash = keccak256(code);
  const executor = '0x' + '11'.repeat(20);
  const chain = createChainRead({ client: {
    getChainId: async () => 11155111,
    getCode: async () => code,
    readContract: async ({ address, functionName }) => {
      assert.equal(address, executor);
      assert.equal(functionName, 'MIN_UPGRADE_DELAY');
      return minimum;
    },
  } });
  const input = {
    projectId: 'prj_zero_delay', owner: '0x' + '22'.repeat(20),
    module: { id: 'module', state: 'verified', chainId: 11155111, address: '0x' + '33'.repeat(20), codeHash },
    configuration: '0x', mandateHash: '0x' + '44'.repeat(32),
    capability: { enabled: true, chainId: 11155111, profile: 'claus-readonly-v1', executor, executorCodeHash: codeHash },
    expiresAt: 1800000000,
  };
  return delay => chain.registration({ ...input, minDelaySeconds: delay });
}

test('new executor prepares a signed zero-delay registration without adding a waiting period', async () => {
  const prepared = await registration(0n)(0);
  assert.equal(prepared.message.minDelaySeconds, 0);
  assert.equal(prepared.primaryType, 'Registration');
});

test('legacy executor refuses an impossible zero-delay registration before requesting an owner signature', async () => {
  const prepare = registration(3600n);
  await assert.rejects(prepare(0), { code: 'executor_delay_required' });
  await assert.rejects(prepare(3599), { code: 'executor_delay_required' });
  assert.equal((await prepare(3600)).message.minDelaySeconds, 3600);
});

test('optional project delays stay explicit and invalid delays are rejected', async () => {
  const prepare = registration(0n);
  assert.equal((await prepare(60)).message.minDelaySeconds, 60);
  for (const delay of [-1, 0.5, undefined, NaN, 432001]) {
    await assert.rejects(prepare(delay), { code: 'invalid_registration' });
  }
});

test('legacy delay conflicts reach the client as non-retryable, not a provider outage', async () => {
  const handle = createHttp({ service: {
    routes: ROUTES.filter(route => route.name === 'registration_prepare'),
    execute: async (_name, input) => registration(3600n)(input.minDelaySeconds),
  } });
  const response = await handle(new Request('https://claus.si/v1/projects/test/chain/registrations/prepare', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minDelaySeconds: 0 }),
  }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'executor_delay_required', retryable: false });
});
