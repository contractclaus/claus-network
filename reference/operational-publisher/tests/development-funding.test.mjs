import test from 'node:test';import assert from 'node:assert/strict';
import {developmentFunding,developmentMaximum} from '../src/resources/development-funding.mjs';
function fixture(high=false){
 const rows=new Map(),calls=[];const store={get:async(k,id)=>structuredClone(rows.get(id)??null),put:async(k,id,v)=>{if(!rows.has(id))rows.set(id,structuredClone(v));return {value:structuredClone(rows.get(id))};},change:async(k,id,r,v)=>{assert.equal(rows.get(id).revision,r);rows.set(id,structuredClone(v));return v;}};
 const fund=developmentFunding({store,budget:async(...args)=>{calls.push(args);},request:async()=>new Response('| Sandbox Active CPU | 5 hours/month | $'+(high?'0.5':'0.128')+'/hour | $0.128/hour |\n| Sandbox Provisioned Memory | 420 GB-hours/month | $0.0212/GB-hour | $0.0212/GB-hour |')});return {fund,calls};
}
test('a long development run reserves and recognizes its maximum once under its original identity',async()=>{
 const f=fixture(),input={actionId:'development:original',vcpus:8,seconds:3600};const a=await f.fund(input);assert.equal(a.maximumMicroUsd,developmentMaximum(input));assert.deepEqual(await f.fund(input),a);assert.deepEqual(f.calls.map(x=>x[0]),['reserve','commit']);assert.equal(f.calls[0][1],f.calls[1][1]);await assert.rejects(f.fund({...input,vcpus:4}),/request_conflict/);
});
test('current prices over the allowance or unsupported machine shapes cannot start a funded run',async()=>{
 const f=fixture(true);await assert.rejects(f.fund({actionId:'development:original',vcpus:8,seconds:3600}),/price_changed/);assert.equal(f.calls.length,0);assert.throws(()=>developmentMaximum({actionId:'development:original',vcpus:32,seconds:3600}),/plan_invalid/);
});
