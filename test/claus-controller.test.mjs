import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/storage/index.mjs';
import { createClausController } from '../adapters/claus-controller.mjs';
import { digest } from '../src/shared/index.mjs';

test('revoked decisions cancel unsent inference and keep reconciling paid uncertainty without POST', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  const proposal = { profile: 'claus-readonly-v1', chainId: 11155111 }, artifactHash = digest('fixture-review');
  const value = { id: 'fixture', projectId: 'prj_fixture', proposal, proposalHash: digest(proposal), reviewArtifactHash: artifactHash };
  const input = { projectId: value.projectId, proposal, proposalHash: value.proposalHash, review: { artifactHash } };
  await store.transaction(tx => tx.write('chain-bindings', value.projectId, { fixture: true }, 0));
  let state = 'uncertain'; const methods = [];
  const controller = createClausController({ store, secret: 'test', chain: {
    validateProposal: async () => { throw Object.assign(Error('stale'), {code: 'proposal_stale'}); }
  }, client: {}, signer: {},
    fetcher: async (_url, options) => { methods.push(options.method); return Response.json({ state }); } });
  const args = { value, input, authorize: async () => false };
  assert.equal((await controller.step(args)).state, 'reviewing');
  assert.deepEqual(methods, ['GET', 'DELETE']);
  state = 'blocked'; assert.equal((await controller.step(args)).state, 'blocked');
  assert.equal(methods.includes('POST'), false);
  assert.equal(await store.read('claus-signed-approvals', value.id), null);
  state = 'uncertain';
  assert.equal((await controller.step({...args, authorize: async () => true})).state, 'reviewing');
  assert.deepEqual(methods.slice(-2), ['GET', 'DELETE']);
});
