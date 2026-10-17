import test from 'node:test';import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';
import {createArtifactStore} from '../src/artifact-store/index.mjs';
import {createJobs} from '../src/jobs/index.mjs';
import {createOciBuilds} from '../src/infrastructure/builds.mjs';

const address='0x1111111111111111111111111111111111111111';
async function setup(t){
 const store=openStore(':memory:');t.after(()=>store.close());let at=200000000;
 const identity={authorize:async()=>{},allowed:async()=>true,credential:async actor=>({kind:'owner',principalId:actor})};
 const entries=[{id:'old-1',projectId:'old',at},{id:'old-2',projectId:'old',at}];
 await store.transaction(async tx=>{await tx.write('principals','claus',{chainId:1,address},0);await tx.write('principals','other',{chainId:1,address:'0x2222222222222222222222222222222222222222'},0);await tx.write('oci-capacity','standard',{entries},0);for(const e of entries){await tx.write('oci-builds',e.id,{state:'compiled'},0);await tx.write('workflow-jobs',e.id,{state:'complete'},0);}});
 const files=[{path:'Dockerfile',content:'FROM scratch\n'}];
 const projects={files:async()=>files,publicSource:async()=>({projectId:'new',snapshotId:'s',files})};
 const api=createOciBuilds({store,identity,projects,jobs:createJobs({store,identity,now:()=>at}),artifacts:createArtifactStore({store}),sourceFiles:{get:async()=>files[0]},privateEnabled:true,privateSecret:'present',reservedPrivateOwner:address,enabled:true,ports:{dispatch:async()=>{},inspect:async()=>{}},now:()=>at});
 return {api,store,entries,advance:()=>at+=90000001,input:{snapshotId:'s',sourceVisibility:'private',publishSource:false,idempotencyKey:'private-one'}};
}

test('Claus gets one private reserved slot while original slots and request identity remain intact',async t=>{
 const f=await setup(t),b=await f.api.submit('claus','new',f.input);
 const capacity=(await f.store.read('oci-capacity','standard')).value.entries;
 assert.deepEqual(capacity.slice(0,2),f.entries);assert.equal(capacity.length,3);assert.equal(capacity[2].reservedPrivate,true);
 assert.equal((await f.api.submit('claus','new',f.input)).id,b.id);
 await assert.rejects(f.api.submit('claus','new',{...f.input,idempotencyKey:'duplicate'}),{code:'oci_build_capacity_reached'});
});
test('another owner and a public build cannot consume the reserved private slot',async t=>{
 const f=await setup(t);
 await assert.rejects(f.api.submit('other','new',f.input),{code:'oci_build_capacity_reached'});
 await assert.rejects(f.api.submit('claus','new',{snapshotId:'s',publishSource:true,idempotencyKey:'public'}),{code:'oci_build_capacity_reached'});
 assert.equal((await f.store.read('oci-capacity','standard')).value.entries.length,2);
});
test('an unresolved reserved build remains occupied beyond the normal window',async t=>{
 const f=await setup(t),b=await f.api.submit('claus','new',f.input);f.advance();
 await f.store.transaction(async tx=>{const current=await tx.read('oci-capacity','standard');await tx.write('oci-capacity','standard',{entries:[...current.value.entries,{id:'fresh-1',projectId:'other',at:290000001},{id:'fresh-2',projectId:'other',at:290000001}]},current.revision);for(const id of ['fresh-1','fresh-2']){await tx.write('oci-builds',id,{state:'compiled'},0);await tx.write('workflow-jobs',id,{state:'complete'},0);}});
 await assert.rejects(f.api.submit('claus','another',{...f.input,idempotencyKey:'replace-unknown'}),{code:'oci_build_capacity_reached'});
 assert((await f.store.read('oci-capacity','standard')).value.entries.some(e=>e.id===b.id&&e.reservedPrivate));
});
test('only one same-source retry follows a confirmed failure, retaining the original record',async t=>{
 const f=await setup(t),b=await f.api.submit('claus','new',f.input);
 const fail=async id=>f.store.transaction(async tx=>{const r=await tx.read('oci-builds',id),j=await tx.read('workflow-jobs',id);await tx.write('oci-builds',id,{...r.value,state:'failed',error:'oci_runner_failure'},r.revision);await tx.write('workflow-jobs',id,{...j.value,state:'failed'},j.revision);});
 await fail(b.id);
 await assert.rejects(f.api.submit('claus','new',{...f.input,snapshotId:'other',idempotencyKey:'different-source'}),{code:'oci_build_capacity_reached'});
 const retry=await f.api.submit('claus','new',{...f.input,idempotencyKey:'repair-one'});
 const entries=(await f.store.read('oci-capacity','standard')).value.entries;
 assert.equal(entries.at(-1).retryOf,b.id);assert.equal(entries.at(-1).reservedRetry,true);
 assert.equal((await f.store.read('oci-builds',b.id)).value.state,'failed');
 await fail(retry.id);
 await assert.rejects(f.api.submit('claus','new',{...f.input,idempotencyKey:'repair-two'}),{code:'oci_build_capacity_reached'});
});
