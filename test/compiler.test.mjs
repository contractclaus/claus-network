import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSnapshot } from '../adapters/compiler.mjs';
test('bounded compilation ties exact source to bytecode and rejects external filesystem imports', async () => {
  const files = [{ path: 'src/Example.sol', content: 'pragma solidity 0.8.27; contract Example { function value() external pure returns(uint256) { return 42; } }' }];
  const a = await compileSnapshot({ files, entry: files[0].path, contract: 'Example' });
  const b = await compileSnapshot({ files, entry: files[0].path, contract: 'Example' });
  assert.equal(a.status, 'compiled'); assert.equal(a.runtimeTemplateHash, b.runtimeTemplateHash);
  assert.equal(a.inputHash, b.inputHash); assert.equal(a.evidenceLevel, 'compiled_only');
  const bad = await compileSnapshot({ files: [{ path: 'src/Example.sol', content: 'pragma solidity 0.8.27; import "/etc/passwd"; contract Example {}' }], entry: 'src/Example.sol', contract: 'Example' });
  assert.equal(bad.status, 'rejected'); assert.ok(bad.errors.some(x => x.message.includes('Only snapshot sources')));
});
