import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hashTypedData } from 'viem';
import { compileSnapshot } from '../adapters/compiler.mjs';
import { validateManagedModule } from '../adapters/managed-module.mjs';
import { validateModule, domain, approvalTypes, approvalMessage } from '../adapters/chain-read.mjs';

test('actual stateful counter compiles for managed; readonly remains readonly and fixed selectors are rejected', async () => {
 const path='reference/managed-counter/Counter.sol', content=await readFile(new URL('../'+path,import.meta.url),'utf8');
 const build=await compileSnapshot({files:[{path,content}],entry:path,contract:'Counter',compilerProfile:'solidity-managed-compile-v1'});
 assert.equal(build.status,'compiled');validateManagedModule(build);
 assert.throws(()=>validateModule(build),{code:'unsupported_module'});
 const reserved={...build,abi:[...build.abi,{type:'function',name:'executor',inputs:[],outputs:[{type:'address'}],stateMutability:'view'}]};
 assert.throws(()=>validateManagedModule(reserved),{code:'reserved_module_selector'});
 const p={profile:'claus-managed-v1',projectKey:'0x'+'12'.repeat(32),configuration:'0x',chainId:1};
 assert.equal(approvalMessage(p,'0x'+'34'.repeat(32)).projectId,p.projectKey);
 const typed={types:{X:[{name:'n',type:'uint256'}]},primaryType:'X',message:{n:1n}},address='0x'+'12'.repeat(20);
 assert.notEqual(hashTypedData({...typed,domain:domain(address,1)}),hashTypedData({...typed,domain:domain(address,1,p.profile)}));
});
