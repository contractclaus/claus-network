import test from 'node:test';
import assert from 'node:assert/strict';
import { selectExecutorCapability } from '../adapters/chain-read.mjs';

const previous = { enabled: true, chainId: 11155111, profile: 'claus-readonly-v1',
  executor: '0x' + 'ab'.repeat(20), executorCodeHash: 'old-code', approvalSigner: 'old-signer',
  executorPayer: 'payer', artifactProjectId: 'old-project', targetArtifactHash: 'old-artifact' };
const current = { ...previous, executor: '0x' + 'cd'.repeat(20), executorCodeHash: 'new-code',
  approvalSigner: 'new-signer', artifactProjectId: 'new-project', targetArtifactHash: 'new-artifact',
  retainedExecutors: [previous] };

test('default replacement and retained executors use their own exact artifacts and signers', () => {
  const selected = selectExecutorCapability(current);
  assert.equal(selected.executor, current.executor);
  assert.equal(selected.targetArtifactHash, 'new-artifact');
  assert.equal('retainedExecutors' in selected, false);
  assert.deepEqual(selectExecutorCapability(current, previous.executor.toUpperCase()), previous);
  assert.throws(() => selectExecutorCapability(current, '0x' + 'ef'.repeat(20)), { code: 'executor_not_enabled' });
});

test('retained executor withdrawal and global disable cannot inherit enabled from the replacement', () => {
  const withdrawn = { ...current, retainedExecutors: [{ ...previous, enabled: false }] };
  assert.equal(selectExecutorCapability(withdrawn, previous.executor).enabled, false);
  assert.equal(selectExecutorCapability(withdrawn).enabled, true);
  assert.equal(selectExecutorCapability({ ...current, enabled: false }, previous.executor).enabled, false);
  assert.equal(selectExecutorCapability({ ...current, enabled: false }).enabled, false);
});
