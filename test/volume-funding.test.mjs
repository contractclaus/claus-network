import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {volumeFundingHandler} from '../src/infrastructure/volume-funding.mjs';
import {validateNetworkVolume} from '../src/infrastructure/volume-bindings.mjs';
import {requireSecretBindingOwner} from '../src/infrastructure/secret-bindings.mjs';
import {CLAUS_IDENTITY} from '../src/partner-launch/policy.mjs';
import {openStore} from '../src/storage/index.mjs';
import {balance} from '../src/billing/index.mjs';
import {canonical,digest} from '../src/shared/index.mjs';
const secret='z'.repeat(40),at=Date.parse('2026-10-18T12:00:00Z');
async function fixture(t){
 const store=openStore(':memory:');t.after(()=>store.close());
 await store.transaction(async tx=>{await tx.write('balances',digest({account:'fund',asset:'USD'}),{account:'fund',asset:'USD',available:'100000000',reserved:'0',spent:'5000'},0);await tx.write('infrastructure-funding','runpod',{enabled:true,fundingAccount:'fund',fundedTotal:'100005000'},0);});
 const handler=volumeFundingHandler({store,secret:()=>secret,now:()=>at}),input={operation:'reserve',id:'act_'+'a'.repeat(24),resourceId:'res_'+'b'.repeat(24),maximum:'700000',fundedUntil:new Date(at+86400000).toISOString()};
 const call=async (value,proofOverride)=>{const body=JSON.stringify(value),timestamp=String(at),proof=proofOverride??createHmac('sha256',secret).update(timestamp+'.'+body).digest('hex');const r=await handler(new Request('https://network/internal/infrastructure/volume-funding',{method:'POST',headers:{'x-claus-timestamp':timestamp,'x-claus-volume-proof':proof},body}));return {status:r.status,value:await r.json()};};
 return {store,input,call};
}
test('storage obligation shares the existing funded pool exactly once and acceptance never invents invoice or refund',async t=>{
 const f=await fixture(t),one=await f.call(f.input);assert.equal(one.status,200);assert.equal(one.value.proof,createHmac('sha256',secret).update(canonical({input:f.input,result:one.value.result})).digest('hex'));
 await f.call(f.input);let b=await balance(f.store,'fund','USD');assert.equal(b.available,'99300000');assert.equal(b.reserved,'700000');assert.equal(b.spent,'5000');
 assert.equal((await f.call({...f.input,operation:'accept'})).status,200);assert.equal((await f.call({...f.input,operation:'cancel'})).status,409);
 b=await balance(f.store,'fund','USD');assert.equal(BigInt(b.available)+BigInt(b.reserved)+BigInt(b.spent),100005000n);
});
test('forged requests, changed original terms and depleted funding cannot create credit; definitive unused reservation can be cancelled',async t=>{
 const f=await fixture(t);assert.equal((await f.call(f.input,'0'.repeat(64))).status,401);await f.call(f.input);
 assert.equal((await f.call({...f.input,maximum:'800000'})).status,409);assert.equal((await f.call({...f.input,operation:'cancel'})).status,200);await f.call({...f.input,operation:'cancel'});
 assert.equal((await balance(f.store,'fund','USD')).available,'100000000');assert.equal((await f.call(f.input)).status,409);
 assert.equal((await f.call({...f.input,id:'act_'+'c'.repeat(24),maximum:'150000000'})).status,409);
});
test('persistent storage references are confined to Claus-owned runtime manifests',()=>{
 const manifest={storageGiB:4096,networkVolume:{resourceId:'res_'+'b'.repeat(24),path:'/workspace/checkpoints'}};
 requireSecretBindingOwner(manifest,{chainId:1,address:CLAUS_IDENTITY});
 assert.throws(()=>requireSecretBindingOwner(manifest,{chainId:1,address:'0x'+'2'.repeat(40)}),/volume_owner_required/);
 assert.throws(()=>validateNetworkVolume({storageGiB:1}),/reference_required/);
 assert.throws(()=>validateNetworkVolume({...manifest,networkVolume:{...manifest.networkVolume,path:'/workspace//bad'}}),/reference_invalid/);
 validateNetworkVolume({storageGiB:0});
});
