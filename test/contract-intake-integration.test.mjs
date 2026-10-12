import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPublicClient, createWalletClient, http, keccak256, stringToHex, decodeEventLog } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createContractInboxRead, inboxAbi } from '../adapters/contract-intake.mjs';
import { createContractIntake } from '../src/contract-intake/index.mjs';
import { openStore } from '../src/storage/index.mjs';
import { createJobs } from '../src/jobs/index.mjs';
import { digest } from '../src/shared/index.mjs';

test('a real local contract event becomes one proposal and an authenticated result callback',
  { skip: !process.env.CLAUS_TEST_CHAIN, timeout: 60000 }, async t => {
  const url = new URL(process.env.CLAUS_TEST_CHAIN);
  assert.equal(url.hostname, '127.0.0.1', 'Never use a public chain for fixtures');
  const client = createPublicClient({ transport: http(url.href, { retryCount: 0 }), cacheTime: 0 });
  assert.equal(await client.getChainId(), 11155111);
  const signer = privateKeyToAccount(generatePrivateKey());
  await client.request({ method: 'anvil_setBalance', params: [signer.address, '0x56bc75e2d63100000'] });
  const wallet = createWalletClient({ account: signer, transport: http(url.href) });
  const artifact = async (file, name) => JSON.parse(await readFile(new URL(`../contracts/out/${file}/${name}.json`, import.meta.url)));
  const inboxArtifact = await artifact('ClausRequestInbox.sol', 'ClausRequestInbox');
  const receiverArtifact = await artifact('ClausRequestInbox.t.sol', 'InboxReceiver');
  const deployed = async (a, args) => {
    const hash = await wallet.deployContract({ chain: null, abi: a.abi, bytecode: a.bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success'); return receipt.contractAddress;
  };
  const inbox = await deployed(inboxArtifact, [signer.address]);
  const receiver = await deployed(receiverArtifact, [inbox]);
  const codeHash = keccak256(await client.getCode({ address: inbox }));
  const chain = createContractInboxRead({ client, inbox, codeHash, dispatcher: signer.address });
  let time = Number((await client.getBlock()).timestamp) * 1000, submitted = 0;
  const store = openStore(':memory:'); t.after(() => store.close());
  const identity = { authorize: async () => {} };
  const jobs = createJobs({ store, identity, now: () => time });
  const proposals = new Map();
  const intake = createContractIntake({ store, identity, jobs, chain, now: () => time, enabled: () => true,
    createProposal: async (_actor, projectId, input) => {
      submitted++;
      const { idempotencyKey, ...body } = input;
      const id = digest({ projectId, idempotencyKey, kind: 'protected-upgrade' });
      const result = { id, projectId, requestHash: digest(body),
        decision: { decision: 'approve', decisionHash: digest({ fixture: 'local decision only' }) } };
      proposals.set(id, result); return result;
    }, readProposal: async (_projectId, id) => proposals.get(id) });
  const binding = await intake.bind('local-fixture', 'project-a', { requester: receiver,
    expiresAt: time + 2 * 86400000, maxRequests: 1, idempotencyKey: 'local' });
  const input = { moduleId: 'local-reviewed-module-fixture', configuration: '0x1234' };
  const sent = await wallet.writeContract({ chain: null, address: receiver, abi: receiverArtifact.abi,
    functionName: 'submitInput', args: [binding.onchainBinding, binding.capability, stringToHex(JSON.stringify(input))] });
  const receipt = await client.waitForTransactionReceipt({ hash: sent });
  const log = receipt.logs.find(x => x.address.toLowerCase() === inbox.toLowerCase());
  const pointer = { transactionHash: sent, logIndex: log.logIndex };
  await assert.rejects(intake.ingest(binding.id, pointer), { code: 'inbox_event_not_finalized' });
  await client.request({ method: 'anvil_mine', params: ['0x60', '0x1'] });
  time = Number((await client.getBlock()).timestamp) * 1000;
  const scanned = await chain.scan({ afterBlock: Number(receipt.blockNumber) - 1 });
  assert.equal(scanned.events.length, 1);
  assert.deepEqual(scanned.events[0], { bindingId: binding.id, ...pointer });
  const request = await intake.ingest(binding.id, pointer);
  assert.deepEqual(await intake.ingest(binding.id, pointer), request);
  await intake.run();
  assert.equal(submitted, 1);
  const saved = (await store.read('contract-requests', request.id)).value;
  const prepared = await chain.resolution(saved);
  assert.equal(prepared.from, signer.address); assert.equal(prepared.value, '0');
  const resolvedHash = await wallet.sendTransaction({ chain: null, to: prepared.to, data: prepared.data, value: 0n });
  assert.equal((await client.waitForTransactionReceipt({ hash: resolvedHash })).status, 'success');
  const cbHash = await wallet.sendTransaction({ chain: null, to: prepared.callback.to, data: prepared.callback.data,
    value: 0n, gas: 750000n });
  assert.equal((await client.waitForTransactionReceipt({ hash: cbHash })).status, 'success');
  assert.equal(await client.readContract({ address: receiver, abi: receiverArtifact.abi, functionName: 'deliveries' }), 1n);
  const event = decodeEventLog({ abi: inboxAbi, data: log.data, topics: log.topics });
  assert.equal((await client.readContract({ address: inbox, abi: inboxAbi, functionName: 'requests', args: [event.args.id] }))[4], true);
  await assert.rejects(client.call({ account: signer.address, to: prepared.callback.to, data: prepared.callback.data }));
  assert.equal(await chain.pending(binding, saved.observation), false);
  assert.equal((await intake.ingest(binding.id, pointer)).id, request.id, 'resolved events remain replayable');
  await assert.rejects(chain.scan({ afterBlock: Number(receipt.blockNumber), blockHash: '0x' + '00'.repeat(32) }), { code: 'inbox_cursor_reorganized' });
});
