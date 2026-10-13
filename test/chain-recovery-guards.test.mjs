import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';
import {checkChainWorkerRoles, createChainWorker} from '../runtime/chain-worker.mjs';
import {recoverChainEvent} from '../adapters/chain-event-recovery.mjs';
import {createHostedContractIntakeWorker} from '../runtime/contract-intake-host.mjs';

test('chain hosts require an explicit secure historical endpoint before connecting to storage', async () => {
  await assert.rejects(createChainWorker('executor', {}), { code: 'historical_rpc_required' });
  await assert.rejects(createChainWorker('controller', { CLAUS_SEPOLIA_RPC_URL: 'http://example.invalid' }),
    { code: 'historical_rpc_required' });
  await assert.rejects(createHostedContractIntakeWorker({}), { code: 'intake_host_unconfigured' });
  const pin={chainId:11155111,inbox:'0x'+'11'.repeat(20),codeHash:'0x'+'11'.repeat(32),dispatcher:'0x'+'22'.repeat(20),
    startBlock:1,reviewProjectId:'review',reviewCaseId:'case',reviewArtifactHash:'sha256:'+'a'.repeat(64)};
  await assert.rejects(createHostedContractIntakeWorker({CLAUS_CONTRACT_INTAKE_PROFILE:JSON.stringify(pin),
    CLAUS_CONTRACT_DISPATCH_BUDGET:'budget',CLAUS_SEPOLIA_RPC_URL:'http://example.invalid'}),{code:'historical_rpc_required'});
});

test('worker role mismatch is rejected even while admission is disabled',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());
 const approval='0x'+'11'.repeat(20),payer='0x'+'22'.repeat(20);
 await store.transaction(tx=>tx.write('network-capabilities','chain:1',{enabled:false,approvalSigner:approval,executorPayer:payer},0));
 await checkChainWorkerRoles(store,'executor',[[1,{address:payer}]]);
 await assert.rejects(checkChainWorkerRoles(store,'executor',[[1,{address:approval}]]),{code:'worker_role_mismatch'});
 await checkChainWorkerRoles(store,'controller',[[1,{address:approval}]]);
 await assert.rejects(checkChainWorkerRoles(store,'controller',[[1,{address:payer}]]),{code:'worker_role_mismatch'});
});

test('event recovery advances bounded finalized ranges without declaring an incomplete history empty',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());let calls=0,fail=false;
 const client={getBlock:async({blockNumber})=>({number:blockNumber??25000n,hash:'0x'+String(blockNumber??25000n)}),
  getLogs:async({fromBlock,toBlock})=>{calls++;assert(toBlock-fromBlock<10000n);if(fail)throw Error('RPC');return fromBlock<=23000n&&toBlock>=23000n?[{blockNumber:23000n}]:[];}};
 const input={store,client,chainId:1,key:'one-original-execution',query:{address:'executor'},fromBlock:500n};
 assert.equal((await recoverChainEvent(input)).complete,false);
 fail=true;await assert.rejects(recoverChainEvent(input));fail=false;
 assert.equal((await recoverChainEvent(input)).complete,false);
 const result=await recoverChainEvent(input);assert.equal(result.complete,true);assert.equal(result.logs[0].blockNumber,23000n);
 assert.equal(calls,4);assert.equal((await store.list('chain-event-recovery',{limit:10})).length,1);
});

test('a changed finalized block preserves the recovery cursor and refuses a new scan', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  let changed = false, scans = 0;
  const client = { getBlock: async ({ blockNumber }) => ({ number: blockNumber ?? 100n, hash: changed ? 'changed' : 'original' }),
    getLogs: async () => { scans++; return []; } };
  const input = { store, client, chainId: 11155111, key: 'registration', query: { address: 'executor' }, fromBlock: 1n };
  await recoverChainEvent(input);
  const before = await store.list('chain-event-recovery'); changed = true;
  await assert.rejects(recoverChainEvent(input), { code: 'recovery_block_changed' });
  assert.deepEqual(await store.list('chain-event-recovery'), before);
  assert.equal(scans, 1);
});

test('disabled managed keys do not halt the existing readonly controller or executor',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());const signer={address:'0x'+'11'.repeat(20)};
 await store.transaction(async tx=>{await tx.write('network-capabilities','chain:1',{enabled:true,approvalSigner:signer.address,executorPayer:signer.address},0);await tx.write('network-capabilities','chain:1:managed',{enabled:false,approvalSigner:'0x'+'22'.repeat(20),executorPayer:'0x'+'33'.repeat(20)},0);});
 await checkChainWorkerRoles(store,'controller',[[1,signer]]);await checkChainWorkerRoles(store,'executor',[[1,signer]]);
});
