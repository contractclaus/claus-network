import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSnapshot, MARKET_COMPILER_PROFILE } from '../adapters/compiler.mjs';
test('bounded compilation ties exact source to bytecode and rejects external filesystem imports', async () => {
  const files = [{ path: 'src/Example.sol', content: 'pragma solidity 0.8.27; contract Example { function value() external pure returns(uint256) { return 42; } }' }];
  const a = await compileSnapshot({ files, entry: files[0].path, contract: 'Example' });
  const b = await compileSnapshot({ files, entry: files[0].path, contract: 'Example' });
  assert.equal(a.status, 'compiled'); assert.equal(a.runtimeTemplateHash, b.runtimeTemplateHash);
  assert.equal(a.inputHash, b.inputHash); assert.equal(a.evidenceLevel, 'compiled_only');
  const bad = await compileSnapshot({ files: [{ path: 'src/Example.sol', content: 'pragma solidity 0.8.27; import "/etc/passwd"; contract Example {}' }], entry: 'src/Example.sol', contract: 'Example' });
  assert.equal(bad.status, 'rejected'); assert.ok(bad.errors.some(x => x.message.includes('Only snapshot sources')));
});

test('the explicitly selected market compiler handles exact 0.8.26 source without changing the default', async () => {
  const input = { files: [{ path: 'Fee.sol', content: 'pragma solidity 0.8.26; contract Fee { function fee() external pure returns(uint24) { return 3000; } }' }], entry: 'Fee.sol', contract: 'Fee' };
  const previous = await compileSnapshot(input);
  assert.equal(previous.status, 'rejected');
  const result = await compileSnapshot({ ...input, compilerProfile: MARKET_COMPILER_PROFILE.profile });
  assert.equal(result.status, 'compiled'); assert.deepEqual(result.profile, MARKET_COMPILER_PROFILE);
  assert.equal(JSON.parse(result.metadata).compiler.version, '0.8.26+commit.8a97fa7a');
  await assert.rejects(compileSnapshot({ ...input, compilerProfile: '/tmp/untrusted-compiler.js' }),
    { code: 'unsupported_compiler_profile' });
});

test('the market compiler accepts snapshot v4 imports but cannot read the host filesystem', async () => {
  const input = { compilerProfile: MARKET_COMPILER_PROFILE.profile, entry: 'Fee.sol', contract: 'Fee', files: [
    { path: 'Fee.sol', content: 'pragma solidity 0.8.26; import { Value } from "@uniswap/v4-core/src/Value.sol"; contract Fee { function fee() external pure returns(uint24) { return Value.fee(); } }' },
    { path: 'lib/v4-core/src/Value.sol', content: 'pragma solidity 0.8.26; library Value { function fee() internal pure returns(uint24) { return 3000; } }' }
  ] };
  assert.equal((await compileSnapshot(input)).status, 'compiled');
  const bad = await compileSnapshot({ ...input, files: [input.files[0]] });
  assert.equal(bad.status, 'rejected'); assert(bad.errors.some(x => x.message.includes('Only snapshot sources')));
  const nested = { ...input, sourceRoot: 'market-contracts', entry: 'market-contracts/' + input.entry,
    files: input.files.map(file => ({ ...file, path: 'market-contracts/' + file.path })) };
  const rooted = await compileSnapshot(nested);
  assert.equal(rooted.status, 'compiled');
  assert(rooted.standardInput.settings.remappings.includes('@uniswap/v4-core/=market-contracts/lib/v4-core/'));
  await assert.rejects(compileSnapshot({ ...nested, sourceRoot: '../market-contracts' }), { code: 'invalid_source_root' });
  await assert.rejects(compileSnapshot({ ...nested, entry: input.entry }), { code: 'entry_outside_source_root' });
});
