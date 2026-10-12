import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createApplication, listen } from '../runtime/server.mjs';
import { openStore } from '../src/storage/index.mjs';
import { createClient } from '../interfaces/sdk.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../interfaces/cli.mjs', import.meta.url));
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'claus-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function environment(extra = {}) {
  const env = { ...process.env };
  for (const key of ['CLAUS_NETWORK_URL', 'CLAUS_NETWORK_TOKEN_FILE', 'CLAUS_NETWORK_NEW_TOKEN_FILE', 'NODE_OPTIONS']) delete env[key];
  return { ...env, ...extra };
}

test('CLI defaults to the deployed API, with no credential on a public request', async t => {
  const dir = await directory(t), preload = join(dir, 'fetch.mjs'), token = join(dir, 'token');
  await writeFile(token, 'cln_' + 'a'.repeat(43));
  await writeFile(preload, `import assert from 'node:assert/strict';
globalThis.fetch = async (url, options) => {
  assert.equal(url.href, 'https://claus-network-api.vercel.app/v1/public/graph');
  assert.equal(options.headers.authorization, undefined);
  assert.equal(options.redirect, 'error');
  return Response.json({nodes: [], edges: []});
};`);
  const result = await execute(process.execPath, ['--import', preload, cli, 'call', 'network_graph'], {
    env: environment({ CLAUS_NETWORK_TOKEN_FILE: token })
  });
  assert.deepEqual(JSON.parse(result.stdout), { nodes: [], edges: [] });
  assert.equal(result.stderr, '');
});

test('SDK reports a non-JSON gateway response without its body and never retries', async () => {
  let calls = 0;
  const client = createClient({ fetch: async () => {
    calls++;
    return new Response('<html>upstream diagnostic must not reach the client error</html>', { status: 502 });
  } });
  await assert.rejects(client.call('project_create', { slug: 'test', name: 'Test', idempotencyKey: 'once' }), error => {
    assert.equal(error.code, 'invalid_api_response');
    assert.equal(error.status, 502);
    assert.deepEqual(error.details, { error: 'invalid_api_response' });
    assert(!String(error).includes('upstream diagnostic'));
    return true;
  });
  assert.equal(calls, 1);
});

test('restarted CLI sessions create private credentials, rotate safely and recover a lost rotation through revocation', async t => {
  const dir = await directory(t), store = openStore(join(dir, 'state.sqlite'));
  const app = createApplication({ store, rateSalt: 'cli-test-rate-limit-salt-with-32-bytes' });
  const requests = [];
  const server = await listen({ fetch: (request, context) => {
    requests.push(new URL(request.url).pathname);
    return app.fetch(request, context);
  } });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  let inputNumber = 0;
  async function run(operation, input = {}, { token, output, preload } = {}) {
    const inputPath = join(dir, 'input-' + ++inputNumber + '.json');
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
    const env = environment({ CLAUS_NETWORK_URL: origin });
    if (token) env.CLAUS_NETWORK_TOKEN_FILE = token;
    if (output) env.CLAUS_NETWORK_NEW_TOKEN_FILE = output;
    const args = [...(preload ? ['--import', preload] : []), cli, 'call', operation, inputPath];
    try {
      const result = await execute(process.execPath, args, { env });
      assert(!result.stdout.includes('cln_'), 'raw credential printed');
      return JSON.parse(result.stdout);
    } catch (error) {
      assert(!error.stdout?.includes('cln_') && !error.stderr?.includes('cln_'), 'raw credential printed on failure');
      throw error;
    }
  }
  const account = privateKeyToAccount(generatePrivateKey());
  const challenge = await run('auth_challenge', { address: account.address });
  const ownerToken = join(dir, 'owner-token');
  const owner = await run('auth_session', { challengeId: challenge.id,
    signature: await account.signMessage({ message: challenge.message }) }, { output: ownerToken });
  assert.equal(owner.token, undefined);
  assert.match(await readFile(ownerToken, 'utf8'), /^cln_[A-Za-z0-9_-]{43}\n$/);
  assert.equal((await stat(ownerToken)).mode & 0o777, 0o600);
  const asOwner = { token: ownerToken };
  const input = { slug: 'cli-project', name: 'CLI project', idempotencyKey: 'original-project' };
  const project = await run('project_create', input, asOwner);
  assert.equal((await run('project_create', input, asOwner)).id, project.id);
  const agent = await run('agent_create', { projectId: project.id, name: 'CLI reader' }, asOwner);
  const grant = () => run('mandate_create', { projectId: project.id, principalId: agent.id,
    scopes: ['project.read'], expiresAt: Date.now() + 600000 }, asOwner);
  const mandate = await grant(), firstToken = join(dir, 'first-token');
  const issued = await run('credential_create', { mandateId: mandate.id }, { ...asOwner, output: firstToken });
  const args = { projectId: project.id };
  assert.equal((await run('project_get', args, { token: firstToken })).id, project.id);
  await assert.rejects(run('project_publish', { ...args, published: true, expectedRevision: 0 }, { token: firstToken }),
    error => error.stderr.trim() === 'scope_denied');
  const before = requests.length;
  await assert.rejects(run('credential_rotate', { credentialId: issued.credential.id }, { token: firstToken }),
    error => error.stderr.includes('CLAUS_NETWORK_NEW_TOKEN_FILE'));
  assert.equal(requests.length, before, 'missing destination must fail before a remote mutation');
  const secondToken = join(dir, 'second-token');
  const rotated = await run('credential_rotate', { credentialId: issued.credential.id }, { token: firstToken, output: secondToken });
  assert.equal((await stat(secondToken)).mode & 0o777, 0o600);
  await assert.rejects(run('project_get', args, { token: firstToken }), error => error.stderr.trim() === 'unauthenticated');
  assert.equal((await run('project_get', args, { token: secondToken })).id, project.id);

  const loseResponse = join(dir, 'lose-response.mjs'), pending = join(dir, 'pending-token');
  await writeFile(loseResponse, `const send = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await send(...args);
  if (new URL(args[0]).pathname.endsWith('/rotate') && response.ok) {
    await response.arrayBuffer();
    throw Error('simulated response lost after successful rotation');
  }
  return response;
};`);
  const rotateArgs = { credentialId: rotated.credential.id };
  await assert.rejects(run('credential_rotate', rotateArgs, { token: secondToken, output: pending, preload: loseResponse }),
    error => error.stderr.includes('response lost'));
  assert.equal(await readFile(pending, 'utf8'), 'pending credential response\n');
  const afterLost = requests.length;
  await assert.rejects(run('credential_rotate', rotateArgs, { token: secondToken, output: pending }),
    error => error.stderr.trim() === 'EEXIST');
  assert.equal(requests.length, afterLost, 'a pending response must not be retried');
  await assert.rejects(run('project_get', args, { token: secondToken }), error => error.stderr.trim() === 'unauthenticated');
  await run('mandate_revoke', { mandateId: mandate.id }, asOwner);
  await assert.rejects(run('credential_create', { mandateId: mandate.id }, { ...asOwner, output: join(dir, 'denied-token') }),
    error => error.stderr.trim() === 'not_found');
  const replacement = await grant(), replacementToken = join(dir, 'replacement-token');
  await run('credential_create', { mandateId: replacement.id }, { ...asOwner, output: replacementToken });
  assert.equal((await run('project_get', args, { token: replacementToken })).id, project.id);
  await run('mandate_revoke', { mandateId: replacement.id }, asOwner);
  await assert.rejects(run('project_get', args, { token: replacementToken }), error => error.stderr.trim() === 'scope_denied');
});
