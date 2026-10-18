import test from 'node:test';import assert from 'node:assert/strict';
import {managedEndpoints} from '../src/resources/endpoints.mjs';
import {endpointTransport} from '../src/resources/endpoint-transport.mjs';
const definition={url:'https://claus-agent.vercel.app/health',method:'GET',provider:'Claus',documentation:'https://claus.si/docs/operating-access',dataRegion:'Provider-managed',exitPlan:'Disable the endpoint',pricingEvidence:'This read has no separate API charge',maximumMicroUsd:'20000',timeoutSeconds:30,maximumResponseBytes:10000,inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},auth:null,idempotencyHeader:'x-request-id',expiresAt:null,capabilities:['health']};
function fixture(transport,budget){const rows=new Map();const store={async get(k,id){return structuredClone(rows.get(k+':'+id)??null);},async put(k,id,v){if(!rows.has(k+':'+id))rows.set(k+':'+id,structuredClone(v));return {value:await this.get(k,id)};},async change(k,id,revision,v){assert.equal(rows.get(k+':'+id).revision,revision);rows.set(k+':'+id,structuredClone(v));},async begin(id,operation,input,prepared){await this.put('action',id,{operation,input,prepared,phase:'prepared'});return {row:{result:await this.get('action',id)}};},async dispatch(id){const row=rows.get('action:'+id);if(row.phase!=='prepared')return false;row.phase='dispatched';return true;},async complete(id,v){rows.get('action:'+id).output=v;return v;}};return managedEndpoints({store,budget,seal:x=>x,open:x=>x,transport});}
test('lost provider response keeps the original reservation and never repeats the call',async()=>{
 let invoked=0;const costs=[];const api=fixture(async()=>{invoked++;throw Error('network_lost');},async(...v)=>costs.push(v));
 const {resource}=await api.call('endpoint_create',{name:'health',purpose:'Observe service availability',definition},'setup');
 const input={resourceId:resource.id,revision:1,arguments:{}};
 assert.equal((await api.call('endpoint_invoke',input,'original')).state,'outcome_unknown');
 assert.equal((await api.call('endpoint_invoke',input,'original')).state,'outcome_unknown');assert.equal(invoked,1);assert(!costs.some(c=>c[0]==='cancel'));
 await assert.rejects(api.call('endpoint_invoke',{...input,arguments:{changed:true}},'original'),/request_conflict/);
});
test('saved response survives settlement interruption and stale revisions are rejected',async()=>{
 let invoked=0,commits=0;const api=fixture(async()=>{invoked++;return {status:200,type:'application/json',text:'{"ready":true}',retryAfter:null};},async op=>{if(op==='commit'&&++commits===1)throw Error('ledger_temporarily_unavailable');});
 const {resource}=await api.call('endpoint_create',{name:'health',purpose:'Observe service availability',definition},'setup');const input={resourceId:resource.id,revision:1,arguments:{}};
 await assert.rejects(api.call('endpoint_invoke',input,'original'),/ledger_temporarily/);const done=await api.call('endpoint_invoke',input,'original');assert.equal(done.successful,true);assert.equal(invoked,1);
 await api.call('endpoint_disable',{resourceId:resource.id,expectedRevision:1},'disable');await assert.rejects(api.call('endpoint_invoke',input,'next'),/endpoint_inactive/);
 assert.equal((await api.call('endpoint_result',{resourceId:resource.id,actionId:done.id})).text,'{"ready":true}');
});
test('private DNS targets are rejected before HTTP',async()=>{
 let requested=false;const transport=endpointTransport({resolve:async()=>[{address:'127.0.0.1'}],request:()=>{requested=true;}});await assert.rejects(transport({url:'https://claus-agent.vercel.app/health',method:'GET',timeoutSeconds:1,maximumBytes:10000}),/private_address/);assert.equal(requested,false);
});
