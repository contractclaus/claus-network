import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'viem';
import { createContractInboxRead } from '../adapters/contract-intake.mjs';

test('dense event ranges and one oversized block advance without losing or repeating logs', async () => {
  const dispatcher = '0x' + '11'.repeat(20), inbox = '0x' + '22'.repeat(20), code = '0x1234';
  const logs = Array.from({ length: 6001 }, (_, logIndex) => ({ blockNumber: 1n, logIndex,
    args: { binding: '0x' + '33'.repeat(32) }, transactionHash: '0x' + logIndex.toString(16).padStart(64, '0') }));
  const ranges = [];
  const client = { getChainId: async () => 11155111, getCode: async () => code,
    readContract: async () => dispatcher, getBlock: async ({ blockNumber }) => ({ number: blockNumber ?? 500n, hash: 'block-' + (blockNumber ?? 500n) }),
    getLogs: async ({ fromBlock, toBlock }) => { ranges.push([fromBlock, toBlock]); return fromBlock <= 1n && toBlock >= 1n ? logs : []; } };
  const chain = createContractInboxRead({ client, inbox, dispatcher, codeHash: keccak256(code) });
  let cursor = { afterBlock: 0 }, received = [];
  for (let page = 0; page < 200 && cursor.afterBlock < 500; page++) {
    const next = await chain.scan(cursor);
    assert(next.events.length <= 32);
    received.push(...next.events); cursor = next.cursor;
  }
  assert.equal(cursor.afterBlock, 500);
  assert.equal(received.length, 6001);
  assert.equal(new Set(received.map(x => x.logIndex)).size, 6001);
  assert(ranges.some(([from, to]) => from === to));
  const lagging = await chain.scan({ afterBlock: 501, blockHash: 'block-501', afterLogIndex: 10 });
  assert.equal(lagging.events.length, 0); assert.equal(lagging.cursor.afterLogIndex, 10);
});

test('RPC topics and exact requester-binding pairs exclude foreign spam before the page limit', async () => {
  const inbox='0x'+'22'.repeat(20), dispatcher='0x'+'11'.repeat(20), requester='0x'+'44'.repeat(20), other='0x'+'55'.repeat(20);
  const word='0x'+'33'.repeat(32), second='0x'+'66'.repeat(32), code='0x1234'; let calls=0;
  const client={getChainId:async()=>11155111,getCode:async()=>code,readContract:async()=>dispatcher,
    getBlock:async()=>({number:500n,hash:'block-500'}),getLogs:async input=>{
      calls++;assert.deepEqual(input.args,{binding:[word,second],requester:[requester,other]});
      return [...Array.from({length:64},(_,logIndex)=>({blockNumber:1n,logIndex,args:{binding:word,requester:other},transactionHash:'foreign'})),
        {blockNumber:1n,logIndex:64,args:{binding:word,requester},transactionHash:'admitted'}];
    }};
  const chain=createContractInboxRead({client,inbox,dispatcher,codeHash:keccak256(code)});
  const page=await chain.scan({afterBlock:0,bindings:[{id:'sha256:'+word.slice(2),requester},{id:'sha256:'+second.slice(2),requester:other}]});
  assert.equal(page.events.length,1);assert.equal(page.events[0].transactionHash,'admitted');assert.equal(page.cursor.afterBlock,500);
  const empty=await chain.scan({afterBlock:0,bindings:[]});assert.equal(empty.events.length,0);assert.equal(calls,1);
});
