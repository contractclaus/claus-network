import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './apps-fixture.mjs';

test('revoked membership rejects replayed joins and writes without affecting other members', async t => {
  const {owner,bob,eve,project}=await fixture(t),projectId=project.id;
  const principalId=(await bob.call('principal_me')).principal.id;
  await owner.call('app_membership',{projectId,principalId,active:false,expectedRevision:1,idempotencyKey:'revoke-bob'});
  for(const idempotencyKey of ['join','fresh-join']) {
    await assert.rejects(bob.call('app_join',{projectId,idempotencyKey}),e=>e.code==='scope_denied');
  }
  await assert.rejects(bob.call('app_record_create',{projectId,collection:'posts',data:{text:'revoked'},idempotencyKey:'write'}),e=>e.code==='app_membership_required');
  await assert.rejects(bob.call('app_events',{projectId}),e=>e.code==='app_membership_required');
  const post=await eve.call('app_record_create',{projectId,collection:'posts',data:{text:'still active'},idempotencyKey:'write'});
  assert.equal(post.data.text,'still active');
  await owner.call('app_membership',{projectId,principalId,active:true,expectedRevision:2,idempotencyKey:'restore-bob'});
  assert.equal((await bob.call('app_join',{projectId,idempotencyKey:'restored-join'})).active,true);
});
