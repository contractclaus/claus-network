import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicClient} from 'viem';
import {dealPorts} from '../runtime/deal-ports.mjs';
import {readonlyPorts} from '../runtime/readonly-ports.mjs';
const pin={chainId:1,contract:'0x'+'11'.repeat(20),codeHash:'0x'+'22'.repeat(32),arbiter:'0x'+'33'.repeat(20),admissionController:'0x'+'44'.repeat(20),maximumDealWei:'1',reviewed:true};
const env={CLAUS_DEAL_PINS:JSON.stringify([pin]),CLAUS_MAINNET_RPC_URL:'https://failed-rpc.example/'};
function rpc(t,error){const calls=[];t.mock.method(globalThis,'fetch',async (request,init)=>{const url=String(request.url??request);const body=JSON.parse(init?.body??await request.text());calls.push({url,...body});const reply=url.includes('failed-rpc')?{error}: {result:'0x1234'};return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,...reply}),{status:200,headers:{'content-type':'application/json'}});});return calls;}
test('deal and contract reads recover unsupported eth_call, preserving the requested block',async t=>{
 const calls=rpc(t,{code:-32601,message:'the method eth_call does not exist/is not available'});let client;dealPorts(env,{clientFactory:options=>(client=createPublicClient(options))});
 const params=[{to:pin.contract,data:'0x1234'},'0x123'];
 assert.equal(await client.request({method:'eth_call',params}),'0x1234');
 assert.equal(await readonlyPorts(env).mainnetClient.request({method:'eth_call',params}),'0x1234');
 assert.equal(calls.length,4);for(const call of calls)assert.deepEqual(call.params,params);
 assert(calls[1].url.includes('ethereum-rpc.publicnode.com'));
});
test('an actual contract revert is not turned into a successful fallback',async t=>{
 const calls=rpc(t,{code:3,message:'execution reverted'});let client;dealPorts(env,{clientFactory:options=>(client=createPublicClient(options))});
 await assert.rejects(client.request({method:'eth_call',params:[{to:pin.contract},'latest']}));assert.equal(calls.length,1);
});
