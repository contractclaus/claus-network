import test from 'node:test';import assert from 'node:assert/strict';import {preparedAuditInput} from '../adapters/imd.mjs';import {digest} from '../src/shared/index.mjs';
test('runtime quote accepts only the provider documented empty entry-list normalization',()=>{
 const request={template:'audit',repoUrl:'https://github.com/contractclaus/claus-network',baseCommit:'a'.repeat(40),github:false,objective:'Read the exact runtime source.'};
 const prepared={...request,contracts:[]};assert.equal(digest(preparedAuditInput(request)),digest(prepared));
 assert.notEqual(digest(preparedAuditInput(request)),digest({...prepared,baseCommit:'b'.repeat(40)}));
 const contract={...request,contracts:['src/Actual.sol']};assert.deepEqual(preparedAuditInput(contract),contract);
 assert.deepEqual(preparedAuditInput({template:'other'}),{template:'other'});
});
