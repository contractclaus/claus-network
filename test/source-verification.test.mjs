import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/storage/index.mjs';
import { createSourceVerification } from '../adapters/source-verification.mjs';

const input = { address: '0x' + '11'.repeat(20), creationTransaction: '0x' + '22'.repeat(32),
  constructorArguments: '0x1234', artifact: { entry: 'src/Example.sol', contract: 'Example',
    profile: { compiler: '0.8.27+commit.40a35a09.Emscripten.clang' }, standardInput: { language: 'Solidity', sources: {} } } };

for (const chainId of [1, 11155111]) test('chain ' + chainId + ': explorer routing stays in the query while source and constructor arguments use the POST body', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  let submitted = 0, indexed = false, sourceSubmissions = 0;
  const fetcher = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'sourcify.dev') {
      assert(parsed.pathname.includes('/' + chainId + '/'));
      if (options.method === 'POST') { sourceSubmissions++; return Response.json({ verificationId: 'verification-one' }); }
      return Response.json({ runtimeMatch: 'exact_match', creationMatch: 'exact_match' });
    }
    assert.equal(parsed.searchParams.get('chainid'), String(chainId));
    assert.equal(parsed.searchParams.get('module'), 'contract');
    assert.equal(parsed.searchParams.get('apikey'), 'local-test-key');
    const action = parsed.searchParams.get('action');
    if (action === 'getsourcecode') {
      assert.equal(options.method, undefined); assert.equal(parsed.searchParams.get('address'), input.address);
      return Response.json({ status: '1', result: [{ SourceCode: indexed ? '{}' : '', ContractName: 'Example', SimilarMatch: '' }] });
    }
    if (action === 'verifysourcecode') {
      submitted++; assert.equal(options.method, 'POST');
      assert.equal(options.body.get('constructorArguments'), '1234');
      assert.equal(options.body.get('constructorArguements'), '1234', 'legacy explorer backend must receive the same constructor bytes');
      assert.equal(options.body.get('contractname'), 'src/Example.sol:Example');
      assert.equal(options.body.get('compilerversion'), 'v0.8.27+commit.40a35a09');
      assert.equal(parsed.searchParams.has('sourceCode'), false);
      return Response.json({ status: '1', result: 'verification-guid' });
    }
    assert.equal(action, 'checkverifystatus'); assert.equal(parsed.searchParams.get('guid'), 'verification-guid');
    return Response.json({ status: '0', result: 'Pending in queue' });
  };
  const verifier = createSourceVerification({ store, etherscanKey: 'local-test-key', fetcher, chainId });
  assert.equal((await verifier.step(input)).state, 'pending');
  await verifier.step(input); assert.equal(submitted, 1); assert.equal(sourceSubmissions, 1);
  indexed = true; const result = await verifier.step(input);
  assert.equal(result.state, 'verified'); assert.equal(result.etherscanMatch, 'exact');
  await assert.rejects(verifier.step({ ...input, constructorArguments: '0x5678' }), { code: 'verification_input_changed' });
});

test('an explorer source listing cannot replace exact creation and runtime matches', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  const verifier = createSourceVerification({ store, etherscanKey: 'local-test-key', fetcher: async (url, options = {}) => {
    if (new URL(url).hostname === 'sourcify.dev') return Response.json(options.method === 'POST'
      ? { verificationId: 'verification-two' } : { runtimeMatch: 'exact_match', creationMatch: 'match' });
    return Response.json({ status: '1', result: [{ SourceCode: '{}', ContractName: 'Example', SimilarMatch: '' }] });
  } });
  const result = await verifier.step(input);
  assert.equal(result.etherscanVerified, true); assert.equal(result.state, 'pending');
});

for (const chainId of [1, 11155111]) test('chain ' + chainId + ': terminal explorer failure retries unchanged input after cooldown and preserves failed GUID', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  let time = 100000, submitted = 0, status = 'Fail - Unable to verify', indexed = false;
  const verifier = createSourceVerification({ store, etherscanKey: 'local-test-key', chainId, now: () => time,
    fetcher: async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'sourcify.dev') return Response.json(options.method === 'POST'
        ? { verificationId: 'source' } : { runtimeMatch: 'exact_match', creationMatch: 'exact_match' });
      const action = parsed.searchParams.get('action');
      if (action === 'getsourcecode') return Response.json({ status: '1', result: [{ SourceCode: indexed ? '{}' : '', ContractName: 'Example' }] });
      if (action === 'verifysourcecode') {
        submitted++;
        assert.equal(options.body.get('constructorArguments'), '1234');
        assert.equal(options.body.get('constructorArguements'), '1234');
        return Response.json({ status: '1', result: 'guid-' + submitted });
      }
      return Response.json({ status: '0', result: status });
    } });
  const failed = await verifier.step(input);
  assert.equal(failed.state, 'pending'); assert.equal(failed.etherscanGuid, undefined);
  const attempts = await store.list('chain-verification-attempts');
  assert.equal(attempts.length, 1); assert.equal(attempts[0].value.guid, 'guid-1');
  assert.equal(attempts[0].value.inputHash, failed.inputHash);
  time += 60000; await verifier.step(input); assert.equal(submitted, 1);
  time++; status = 'Pending in queue'; const retry = await verifier.step(input);
  assert.equal(submitted, 2); assert.equal(retry.etherscanGuid, 'guid-2');
  time += 120000; await verifier.step(input); assert.equal(submitted, 2);
  status = 'Max rate limit reached'; await verifier.step(input); assert.equal(submitted, 2);
  status = 'Pass - Verified'; await verifier.step(input); assert.equal(submitted, 2);
  indexed = true; assert.equal((await verifier.step(input)).state, 'verified');
  assert.equal((await store.list('chain-verification-attempts')).length, 1);
});

test('Sourcify HTML service failure keeps the retryable provider error', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  const verifier = createSourceVerification({ store, etherscanKey: 'local-test-key',
    fetcher: async () => new Response('<html>Bad Gateway</html>', { status: 502 }) });
  await assert.rejects(verifier.step(input), { code: 'verification_service_unavailable' });
});

test('a status transport failure resumes the saved GUID without another submission', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  let posts = 0, polls = 0;
  const verifier = createSourceVerification({ store, etherscanKey: 'local-test-key', fetcher: async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'sourcify.dev') return Response.json(options.method === 'POST'
      ? { verificationId: 'source' } : { runtimeMatch: 'exact_match', creationMatch: 'exact_match' });
    switch (parsed.searchParams.get('action')) {
      case 'getsourcecode': return Response.json({ status: '1', result: [{ SourceCode: '' }] });
      case 'verifysourcecode': posts++; return Response.json({ status: '1', result: 'saved-guid' });
      default: polls++; assert.equal(parsed.searchParams.get('guid'), 'saved-guid');
        return polls === 1 ? new Response('unavailable', { status: 503 }) : Response.json({ status: '0', result: 'Pending in queue' });
    }
  } });
  await assert.rejects(verifier.step(input), { code: 'verification_service_unavailable' });
  await verifier.step(input); assert.equal(posts, 1); assert.equal(polls, 2);
});
