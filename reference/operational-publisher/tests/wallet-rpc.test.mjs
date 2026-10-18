import test from 'node:test';import assert from 'node:assert/strict';import {custom} from 'viem';import {mainnet,base} from 'viem/chains';
import {operatingRpc} from '../src/wallet-rpc.mjs';
test('a failed provider falls back for receipts and only rebroadcasts identical signed bytes',async()=>{
 for(const [chain,method,params] of [[mainnet,'eth_getTransactionReceipt',['0xoriginal']],[base,'eth_sendRawTransaction',['0x010203']]]){
  const calls=[],transport=operatingRpc(chain.id,'https://failed.example',{httpFactory:url=>custom({request:async request=>{calls.push({url,...request});if(url==='https://failed.example')throw Error('provider unavailable');return 'original-result';}},{retryCount:0})})({chain});
  assert.equal(await transport.request({method,params}),'original-result');assert.equal(calls.length,2);assert.equal(calls[0].method,calls[1].method);assert.deepEqual(calls[0].params,calls[1].params);
 }
});
test('public-primary deduplication still keeps an independent fallback and rejects unsupported chains',()=>{
 const urls=[];operatingRpc(1,'https://ethereum-rpc.publicnode.com',{httpFactory:url=>{urls.push(url);return custom({request:async()=>null});}});
 assert.equal(urls.length,2);assert.equal(new Set(urls).size,2);assert.throws(()=>operatingRpc(42),/unsupported/);
});
