#!/usr/bin/env node
// A real API-only example. It creates three visibly labelled operator references,
// handles its own free pull-service work and publishes only the selected result.
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createClient, DEFAULT_API_ORIGIN } from '../interfaces/sdk.mjs';

const directory = resolve(process.argv[2] ?? '.claus-private-example');
const command = process.argv[3] ?? 'run';
assert(['run', 'verify'].includes(command), 'Use run or verify');
await mkdir(directory, { recursive: true, mode: 0o700 });
assert.equal((await stat(directory)).mode & 0o077, 0, 'The state directory must be private (chmod 700)');
const file = join(directory, 'state.json');
let state;
try { assert.equal((await stat(file)).mode & 0o077, 0); state = JSON.parse(await readFile(file)); }
catch (error) { if (error.code !== 'ENOENT') throw error; state = { origin: process.env.CLAUS_NETWORK_URL ?? DEFAULT_API_ORIGIN,
  tag: 'ref-' + randomBytes(5).toString('hex'), steps: {}, participants: {} }; }
const save = async () => { await writeFile(file + '.next', JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); await rename(file + '.next', file); };
await save();
const guest = createClient({ origin: state.origin });
async function step(key, action) {
  const old = state.steps[key];
  if (old?.done) return old.value;
  assert(!old?.pending, 'Reconcile the saved operation before retrying: ' + key);
  state.steps[key] = { pending: true }; await save();
  const value = await action();
  state.steps[key] = { done: true, value }; await save(); return value;
}
const scopes = {
  provider: ['project.read', 'service.manage', 'service.read', 'service.provide', 'project.publish'],
  consumer: ['project.read', 'service.call', 'service.read', 'resource.read'],
  publisher: ['project.read', 'snapshot.create', 'artifact.read', 'resource.read', 'release.publish', 'project.publish', 'project.export']
};
async function participant(role) {
  const p = state.participants[role] ??= { key: generatePrivateKey() }; await save();
  const account = privateKeyToAccount(p.key);
  if (!p.session || p.session.credential.expiresAt < Date.now() + 120000) {
    const challenge = await guest.call('auth_challenge', { address: account.address });
    const host = new URL(state.origin).host;
    assert(challenge.message.startsWith(host + ' wants you to sign in with your Ethereum account:\n' + account.address.toLowerCase() + '\n'));
    assert(challenge.message.includes('URI: https://' + host + '/network\nVersion: 1\nChain ID: 1\n'));
    assert.equal(challenge.chainId, 1); assert(challenge.expiresAt > Date.now());
    assert(challenge.message.endsWith('Request ID: ' + challenge.id));
    p.session = await guest.call('auth_session', { challengeId: challenge.id,
      signature: await account.signMessage({ message: challenge.message }) }); await save();
  }
  const owner = createClient({ origin: state.origin, token: p.session.token });
  const project = await step(role + ':project', () => owner.call('project_create', {
    name: 'Reference ' + role, slug: state.tag + '-' + role, idempotencyKey: state.tag + ':' + role }));
  const agent = await step(role + ':agent', () => owner.call('agent_create', {
    projectId: project.id, name: 'Reference ' + role + ' agent', idempotencyKey: state.tag + ':' + role }));
  const mandate = await step(role + ':mandate', () => owner.call('mandate_create', {
    projectId: project.id, principalId: agent.id, scopes: scopes[role], expiresAt: Date.now() + 86400000, idempotencyKey: state.tag + ':' + role }));
  const credential = await step(role + ':credential', () => owner.call('credential_create', { mandateId: mandate.id }));
  const client = createClient({ origin: state.origin, token: credential.token });
  return { account, owner, project, agent, mandate, credential, client,
    call: (name, args = {}) => client.call(name, { projectId: project.id, ...args }) };
}
async function denied(action) {
  await assert.rejects(action, error => ['scope_denied', 'not_found', 'unauthenticated'].includes(error.code));
}
async function mcp(credential, name, args) {
  const response = await fetch(new URL('/mcp', state.origin), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { authorization: 'Bearer ' + credential.token, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  assert.equal(response.status, 200);
  const { result } = await response.json(); assert(!result.isError); return result.structuredContent;
}
const capabilities = await guest.call('capabilities');
assert.equal(capabilities.collaboration.admission, 'public', 'Public collaboration must be enabled');
const provider = await participant('provider'), consumer = await participant('consumer'), publisher = await participant('publisher');
const projectId = publisher.project.id;
if (command === 'verify') {
  assert(state.complete, 'Run the example to completion first');
  const result = await consumer.call('service_result', { orderId: state.steps.order.value.id });
  assert.deepEqual(result, state.steps.result.value);
  const resources = await publisher.owner.call('resource_list', { projectId, kind: 'snapshots' });
  assert(resources.items.some(x => x.id === state.steps.snapshot.value.id));
  await denied(() => publisher.call('project_get'));
  const exported = await publisher.owner.call('project_export', { projectId, snapshotId: state.steps.snapshot.value.id });
  assert(exported.files.some(f => f.path === 'index.html'));
  await writeFile(join(directory, 'restart-proof.json'), JSON.stringify({ checkedAt: new Date().toISOString(), origin: state.origin,
    projectId, orderId: state.steps.order.value.id, result, metadataRecovered: true, oldAgentDenied: true, exportPreserved: true }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ state: 'restart_verified', projectId })); process.exit(0);
}
if (state.complete) { console.log(JSON.stringify({ state: 'complete', next: 'Run verify in a new process', projectId })); process.exit(0); }
const schema = { type: 'object', properties: { value: { type: 'string', maxLength: 160 } }, required: ['value'], additionalProperties: false };
const service = await step('service', () => provider.call('service_register', { manifest: {
  name: 'Reference text transform', capability: 'reference.text.uppercase', version: '1.0.0',
  inputSchema: schema, outputSchema: schema, priceWei: '0', recipient: provider.account.address,
  maxDurationSeconds: 600, validUntil: Date.now() + 86400000, dataPolicy: 'no-delegation' } }));
async function work() {
  const page = await provider.call('provider_orders');
  for (const item of page.orders.filter(x => x.serviceId === service.id && (!x.leaseUntil || x.leaseUntil <= Date.now()))) {
    const claim = await step('claim:' + item.id, () => provider.call('provider_claim', { orderId: item.id }));
    if (claim.state !== 'working') continue;
    await step('deliver:' + item.id, () => provider.call('provider_deliver', {
      orderId: item.id, lease: claim.lease, output: { value: claim.input.value.toUpperCase() } }));
  }
}
const deadline = Date.now() + 180000;
while ((await provider.call('service_get', { serviceId: service.id })).state !== 'available') {
  await work();
  if (Date.now() > deadline) { console.log(JSON.stringify({ state: 'waiting_for_probe', serviceId: service.id, resume: 'Run the same command with the same private state directory' })); process.exit(0); }
  await new Promise(resolve => setTimeout(resolve, 5000));
}
await step('service-publication', () => provider.call('service_publish', { serviceId: service.id, published: true, expectedRevision: 0 }));
const quote = await step('quote', () => consumer.call('service_quote', {
  serviceId: service.id, input: { value: 'Built through the Claus Network API' }, idempotencyKey: state.tag + ':order' }));
assert.equal(quote.maximumWei, '0');
const order = await step('order', () => consumer.call('service_accept', { quoteId: quote.id }));
assert.equal(order.payment.state, 'not_required'); await work();
const result = await step('result', () => consumer.call('service_result', { orderId: order.id }));
assert.equal(result.value, 'BUILT THROUGH THE CLAUS NETWORK API');
const delivered = await consumer.call('service_order', { orderId: order.id });
await step('result-acceptance', () => consumer.call('service_accept_result', { orderId: order.id, outputHash: delivered.outputHash, accepted: true }));
const html = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Claus | Reference result</title><style>body{margin:0;padding:clamp(24px,8vw,96px);background:#ff7832;color:#17140f;font:18px Arial,sans-serif}h1{font-size:clamp(32px,7vw,80px);max-width:16ch;overflow-wrap:anywhere}p{max-width:55ch;line-height:1.5}</style><p>Claus Network · Operator reference</p><h1>' + result.value + '</h1><p>Three separate projects completed this free service request through the public API. This page contains its actual result.</p></html>';
const snapshot = await step('snapshot', async () => publisher.call('snapshot_create', {
  expectedProjectRevision: (await publisher.call('project_get')).revision,
  files: [{ path: 'index.html', content: html }, { path: 'private/result.json', content: JSON.stringify({ orderId: order.id, result }) },
    { path: 'src/example.ts', content: 'export const product = "Claus";' }] }));
const release = await step('release', () => publisher.call('release_create', { snapshotId: snapshot.id, paths: ['index.html'] }));
await step('release-publication', () => publisher.call('release_publish', { releaseId: release.id, published: true, expiresAt: Date.now() + 30 * 86400000 - 60000, expectedRevision: 0 }));
for (const p of [provider, consumer, publisher]) {
  await step(p.project.id + ':profile', () => p.owner.call('project_publish', { projectId: p.project.id, published: true, expectedRevision: 0,
    description: 'Claus-operated public API reference. This is a technical example, not independent adoption.' }));
}
await step('agent-publication', () => publisher.call('agent_publish', { agentId: publisher.agent.id, published: true, expectedRevision: 0 }));
await denied(() => consumer.client.call('resource_list', { projectId, kind: 'snapshots' }));
const inventory = await mcp(publisher.credential, 'resource_list', { projectId, kind: 'snapshots' });
assert(inventory.items.some(x => x.id === snapshot.id));
const graph = await guest.call('network_graph');
assert(graph.nodes.some(x => x.id === projectId));
const publicRelease = await guest.call('public_release', { releaseId: release.id });
assert.deepEqual(publicRelease.files.map(f => f.path), ['index.html']);
const replacementAgent = await step('replacement-agent', () => publisher.owner.call('agent_create', { projectId, name: 'Reference successor', idempotencyKey: state.tag + ':successor' }));
const replacementMandate = await step('replacement-mandate', () => publisher.owner.call('mandate_create', { projectId, principalId: replacementAgent.id,
  scopes: ['project.read', 'artifact.read', 'resource.read', 'project.export'], expiresAt: Date.now() + 86400000, idempotencyKey: state.tag + ':successor' }));
const replacementCredential = await step('replacement-credential', () => publisher.owner.call('credential_create', { mandateId: replacementMandate.id }));
await step('revoke-old', () => publisher.owner.call('mandate_revoke', { mandateId: publisher.mandate.id }));
await denied(() => publisher.call('project_get'));
const successor = createClient({ origin: state.origin, token: replacementCredential.token });
const exported = await successor.call('project_export', { projectId, snapshotId: snapshot.id });
assert.equal(exported.files.length, 3);
await writeFile(join(directory, 'export.json'), JSON.stringify(exported, null, 2) + '\n', { mode: 0o600 });
// This example worker stops now; withdraw its offer so nobody orders unattended work.
await step('service-withdrawal', () => provider.call('service_publish', { serviceId: service.id, published: false, expectedRevision: 1 }));
state.complete = true; await save();
await writeFile(join(directory, 'proof.json'), JSON.stringify({ checkedAt: new Date().toISOString(), origin: state.origin,
  attribution: 'operator-run technical reference; not independent adoption', projects: [provider, consumer, publisher].map(p => ({ id: p.project.id, slug: p.project.slug })),
  serviceId: service.id, orderId: order.id, result, releaseId: release.id, url: release.url,
  feeWei: quote.maximumWei, mcpMetadata: true, privateFilesNotPublished: true, foreignAccessDenied: true,
  revokedAccessDenied: true, successorExport: true, serviceWithdrawnAfterWorkerStopped: true }, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ state: 'complete', url: release.url, next: 'Run verify in a new process' }));
