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
  assert.equal(retry.etherscanError, undefined);
  time += 120000; await verifier.step(input); assert.equal(submitted, 2);
  status = 'Max rate limit reached'; await verifier.step(input); assert.equal(submitted, 2);
  time += 3600000; status = 'Pass - Verified'; const passed = await verifier.step(input); assert.equal(submitted, 2);
  assert.equal(passed.etherscanError, undefined); assert.equal(passed.state, 'pending');
  indexed = true; assert.equal((await verifier.step(input)).state, 'verified');
  const history = await store.list('chain-verification-attempts');
  assert.equal(history.length, 2); assert.equal(history.filter(x => x.value.failedAt).length, 1);
});

test('Sourcify HTML service failure keeps the retryable provider error', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  const verifier = createSourceVerification({ store, etherscanKey: 'local-test-key',
    fetcher: async () => new Response('<html>Bad Gateway</html>', { status: 502 }) });
  await assert.rejects(verifier.step(input), { code: 'verification_service_unavailable' });
});

test('Sourcify already-verified response is remembered without treating it as exact proof', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  let posts = 0, exact = false;
  const verifier = createSourceVerification({ store, etherscanKey: 'local-test-key', fetcher: async (url, options = {}) => {
    if (new URL(url).hostname === 'sourcify.dev') {
      if (options.method === 'POST') { posts++; return Response.json({ customCode: 'already_verified' }, { status: 409 }); }
      return Response.json({ runtimeMatch: 'exact_match', creationMatch: exact ? 'exact_match' : 'match' });
    }
    return Response.json({ status: '1', result: [{ SourceCode: '{}', ContractName: 'Example' }] });
  } });
  for (let i = 0; i < 4; i++) assert.equal((await verifier.step(input)).state, 'pending');
  assert.equal(posts, 1); exact = true;
  assert.equal((await verifier.step(input)).state, 'verified'); assert.equal(posts, 1);
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

for (const failure of ['terminal', 'http', 'refused']) test('explorer submissions are capped after three ' + failure + ' failures and external verification still completes', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  let time = 100000, posts = 0, indexed = false;
  const verifier = createSourceVerification({ store, etherscanKey: 'local-test-key', now: () => time,
    fetcher: async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'sourcify.dev') return Response.json(options.method === 'POST'
        ? { verificationId: 'source' } : { runtimeMatch: 'exact_match', creationMatch: 'exact_match' });
      switch (parsed.searchParams.get('action')) {
        case 'getsourcecode': return Response.json({ status: '1', result: [{ SourceCode: indexed ? '{}' : '', ContractName: 'Example' }] });
        case 'verifysourcecode': posts++;
          if (failure === 'http') return new Response('unavailable', { status: 503 });
          return Response.json(failure === 'refused' ? { status: '0', result: 'Unable to verify' } : { status: '1', result: 'guid-' + posts });
        default: return Response.json({ status: '0', result: 'Fail - Unable to verify' });
      }
    } });
  let result;
  for (let i = 0; i < 20; i++) {
    try { result = await verifier.step(input); }
    catch (e) { assert.equal(failure, 'http'); assert.equal(e.code, 'verification_service_unavailable'); }
    time += 90000;
  }
  assert.equal(posts, 3); assert.equal(result.etherscanSubmissionCount, 3);
  assert.equal(result.etherscanState, 'operator_action_required');
  assert.equal(result.etherscanRetryExhausted, true); assert.equal(result.state, 'pending');
  assert.equal((await store.list('chain-verification-attempts')).length, failure === 'terminal' ? 3 : 0);
  indexed = true; time += 3600000; result = await verifier.step(input);
  assert.equal(result.state, 'verified'); assert.equal(result.etherscanState, 'verified');
  assert.equal(result.etherscanRetryExhausted, false); assert.equal(posts, 3);
});

test('concurrent verifier steps cannot exceed the reserved submission cap', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  let posts = 0, time = 100000;
  const verifier = createSourceVerification({ store, etherscanKey: 'local-test-key', now: () => time,
    fetcher: async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'sourcify.dev') return Response.json(options.method === 'POST'
        ? { verificationId: 'source' } : { runtimeMatch: 'exact_match', creationMatch: 'exact_match' });
      switch (parsed.searchParams.get('action')) {
        case 'getsourcecode': return Response.json({ status: '1', result: [{ SourceCode: '' }] });
        case 'verifysourcecode': posts++; return Response.json({ status: '1', result: 'guid-' + posts });
        default: return Response.json({ status: '0', result: 'Fail - Unable to verify' });
      }
    } });
  for (let round = 0; round < 6; round++) {
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => verifier.step(input)));
    for (const r of results) if (r.status === 'rejected') assert.equal(r.reason.code, 'verification_step_stale');
    time += 90000;
  }
  assert.equal(posts, 3);
  assert.equal((await store.list('chain-verification-attempts')).length, 3);
});

for (const message of ['Unable to locate ContractCode at 0x1234', 'Max rate limit reached', 'Invalid API Key'])
test('explicit refusal recovers after backoff without spending a verification attempt: ' + message, async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  let time = 100000, refused = true, posts = 0, accepted = 0;
  const verifier = createSourceVerification({ store, etherscanKey: 'key', now: () => time,
    fetcher: async (url, options = {}) => {
      const u = new URL(url);
      if (u.hostname === 'sourcify.dev') return Response.json(options.method === 'POST'
        ? { verificationId: 'source' } : { runtimeMatch: 'exact_match', creationMatch: 'exact_match' });
      if (u.searchParams.get('action') === 'getsourcecode') return Response.json({ status: '1', result: [{ SourceCode: '' }] });
      if (u.searchParams.get('action') === 'verifysourcecode') {
        posts++;
        if (refused) return Response.json({ status: '0', result: message });
        accepted++; return Response.json({ status: '1', result: 'recovered-guid' });
      }
      return Response.json({ status: '0', result: 'Pending in queue' });
    } });
  let result;
  for (let i = 0; i < 120; i++) { result = await verifier.step(input); time += 30000; }
  assert(posts <= 6, 'an hour of refusals must not produce a request every tick');
  assert.equal(result.etherscanSubmissionCount, 0); assert.equal(accepted, 0);
  refused = false; time += 3600000; result = await verifier.step(input);
  assert.equal(result.etherscanGuid, 'recovered-guid'); assert.equal(result.etherscanSubmissionCount, 1);
  assert.equal(accepted, 1); assert.equal(result.etherscanError, undefined);
});

test('a refused source listing backs off before any submission', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  let time = 100000, calls = 0;
  const verifier = createSourceVerification({ store, etherscanKey: 'key', now: () => time,
    fetcher: async (url, options = {}) => {
      calls++; const u = new URL(url);
      if (u.hostname === 'sourcify.dev') return Response.json(options.method === 'POST'
        ? { verificationId: 'source' } : { runtimeMatch: 'exact_match', creationMatch: 'exact_match' });
      assert.equal(u.searchParams.get('action'), 'getsourcecode');
      return Response.json({ status: '0', result: 'Invalid API Key' });
    } });
  const first = await verifier.step(input); assert.equal(first.etherscanSubmissionCount, 0);
  const before = calls;
  for (let i = 0; i < 59; i++) { time += 1000; await verifier.step(input); }
  assert.equal(calls, before);
});

test('a concurrent read cannot discard an accepted GUID or cause its resubmission', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  let time = 100000, posts = 0, release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const posted = new Promise(resolve => { entered = resolve; });
  const verifier = createSourceVerification({ store, etherscanKey: 'key', now: () => time,
    fetcher: async (url, options = {}) => {
      const u = new URL(url);
      if (u.hostname === 'sourcify.dev') return Response.json(options.method === 'POST'
        ? { verificationId: 'source' } : { runtimeMatch: 'exact_match', creationMatch: 'exact_match' });
      if (u.searchParams.get('action') === 'getsourcecode') return Response.json({ status: '1', result: [{ SourceCode: '' }] });
      if (u.searchParams.get('action') === 'verifysourcecode') {
        posts++; entered(); await gate; return Response.json({ status: '1', result: 'original-guid' });
      }
      assert.equal(u.searchParams.get('guid'), 'original-guid');
      return Response.json({ status: '0', result: 'Pending in queue' });
    } });
  const pending = verifier.step(input); await posted;
  const reserved = await verifier.step(input);
  // Also model a separately completed read updating diagnostics while the POST is in flight.
  const row = await store.read('chain-verifications', reserved.id);
  await store.transaction(tx => tx.write('chain-verifications', reserved.id, { ...row.value, diagnostic: 'concurrent read' }, row.revision));
  release(); const result = await pending;
  assert.equal(result.etherscanGuid, 'original-guid'); assert.equal(result.diagnostic, 'concurrent read');
  const history = await store.list('chain-verification-attempts');
  assert.equal(history.length, 1); assert.equal(history[0].value.guid, 'original-guid');
  time += 61000; await verifier.step(input); assert.equal(posts, 1);
});

test('exhausted verification polls at most hourly and can still observe exact external completion', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  let time = 100000, calls = 0, indexed = false;
  const verifier = createSourceVerification({ store, etherscanKey: 'key', now: () => time,
    fetcher: async (url, options = {}) => {
      calls++; const u = new URL(url);
      if (u.hostname === 'sourcify.dev') return Response.json(options.method === 'POST'
        ? { verificationId: 'source' } : { runtimeMatch: 'exact_match', creationMatch: 'exact_match' });
      if (u.searchParams.get('action') === 'getsourcecode') return Response.json({ status: '1', result: [{ SourceCode: indexed ? '{}' : '', ContractName: 'Example' }] });
      return Response.json({ status: '0', result: 'Unable to verify' });
    } });
  let result;
  for (let i = 0; i < 3; i++) { result = await verifier.step(input); time += 90000; }
  assert.equal(result.etherscanState, 'operator_action_required');
  const before = calls;
  for (let i = 0; i < 100; i++) { await verifier.step(input); time += 30000; }
  assert.equal(calls, before);
  indexed = true; time += 3600000; assert.equal((await verifier.step(input)).state, 'verified');
});

function metadataFreeFixture() {
  const request = structuredClone(input);
  request.constructorArguments = '0x';
  Object.assign(request.artifact, { creationBytecode: '0x60006001', runtimeTemplate: '0x6001', immutableReferences: {} });
  request.artifact.profile.profile = 'solidity-managed-compile-v1';
  request.artifact.standardInput = { language: 'Solidity', sources: { 'src/Example.sol': { content: 'contract Example {}' } },
    settings: { metadata: { appendCBOR: false, bytecodeHash: 'none' }, outputSelection: { '*': { '*': ['abi'] } } } };
  const compiledInput = structuredClone(request.artifact.standardInput); delete compiledInput.settings.outputSelection;
  const code = bytecode => ({ onchainBytecode: bytecode, recompiledBytecode: bytecode, transformations: [], cborAuxdata: {} });
  const response = { chainId: '1', address: request.address, creationMatch: 'match', runtimeMatch: 'match',
    deployment: { transactionHash: request.creationTransaction }, stdJsonInput: compiledInput,
    compilation: { compilerVersion: '0.8.27+commit.40a35a09', fullyQualifiedName: 'src/Example.sol:Example' },
    creationBytecode: code(request.artifact.creationBytecode), runtimeBytecode: { ...code(request.artifact.runtimeTemplate), immutableReferences: {} } };
  return { request, response };
}

async function verifyMetadataFree(fixture, store, counter = { posts: 0 }) {
  return createSourceVerification({ store, chainId: 1, etherscanKey: 'key', fetcher: async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'sourcify.dev') {
      if (options.method === 'POST') { counter.posts++; return Response.json({ verificationId: 'retained-source-id' }); }
      return Response.json(fixture.response);
    }
    return Response.json({ status: '1', result: [{ SourceCode: '{}', ContractName: 'Example' }] });
  } }).step(fixture.request);
}

test('metadata-free verification resumes original submission with exact full bytecode and pinned source', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  const f = metadataFreeFixture(), count = { posts: 0 }, expected = f.response.runtimeBytecode.onchainBytecode;
  f.response.runtimeBytecode.onchainBytecode = '0x6002';
  assert.equal((await verifyMetadataFree(f, store, count)).state, 'pending');
  f.response.runtimeBytecode.onchainBytecode = expected;
  const result = await verifyMetadataFree(f, store, count);
  assert.equal(result.state, 'verified'); assert.equal(count.posts, 1);
  assert.equal(result.sourcifyId, 'retained-source-id'); assert.equal(result.runtimeMatch, 'match');
  assert.equal(result.metadataFreeEvidence.metadataFingerprintVerified, false);
});

test('metadata-free verification rejects changed code, source, deployment identity and relaxed compiler profiles', async () => {
  const mutations = [
    f => { f.response.runtimeBytecode.onchainBytecode = '0x6002'; },
    f => { f.response.creationBytecode.recompiledBytecode = '0x6002'; },
    f => { f.response.stdJsonInput.sources['src/Example.sol'].content += '// different source'; },
    f => { f.response.address = '0x' + '33'.repeat(20); },
    f => { f.response.deployment.transactionHash = '0x' + '33'.repeat(32); },
    f => { f.response.compilation.compilerVersion = '0.8.26'; },
    f => { f.response.runtimeBytecode.transformations = [{ reason: 'cborAuxdata' }]; },
    f => { f.request.artifact.standardInput.settings.metadata.appendCBOR = true; },
    f => { f.request.artifact.profile.profile = 'solidity-compile-v1'; },
    f => { f.response.runtimeBytecode.immutableReferences = { 1: [{ start: 1, length: 32 }] }; },
    f => { f.request.constructorArguments = '0x01'; }
  ];
  for (const mutate of mutations) {
    const store = openStore(':memory:');
    try { const f = metadataFreeFixture(); mutate(f); assert.equal((await verifyMetadataFree(f, store)).state, 'pending'); }
    finally { await store.close(); }
  }
});
