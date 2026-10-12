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
