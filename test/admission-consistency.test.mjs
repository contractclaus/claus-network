import test from'node:test';import assert from'node:assert/strict';import{openStore}from'../src/storage/index.mjs';import{createApplication}from'../runtime/server.mjs';
for(const [runtime,permission]of [[true,true],[true,false],[false,true]])test(`inference admission uses actual runtime=${runtime} and permission=${permission}`,async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());await store.transaction(async tx=>{await tx.write('network-capabilities','inference',{enabled:permission},0);await tx.write('network-capabilities','collaboration',{enabled:true},0);});
 const app=createApplication({store,rateSalt:'r'.repeat(32),inferencePorts:{enabled:runtime}}),access=await app.access.discovery(),caps=await app.service.execute('capabilities',{});
 assert.equal(access.publicInference,runtime&&permission?'project_allowance':'not_enabled');assert.equal(access.inference.enabled,runtime&&permission);assert.deepEqual(caps.inference,access.inference);assert.equal(caps.publicInference,access.publicInference);assert.equal(caps.collaboration.admission,access.collaboration.admission);assert.equal(caps.collaboration.worker,access.collaboration.worker);assert.equal(caps.collaboration.jobBriefs,true);assert.equal(caps.inference.streaming,false);
 const before=await store.list('inference-allowances',{limit:10});assert.equal(before.length,0,'discovery never grants credit');
});
