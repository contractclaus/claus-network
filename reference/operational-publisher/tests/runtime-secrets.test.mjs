import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeSecrets,runtimeBindings} from '../src/infrastructure/runtime-secrets.mjs';
import {runtimeReleaseApproved} from '../src/infrastructure/release.mjs';
import {runpodDriver} from '../src/infrastructure/providers.mjs';
import {digest} from '../src/infrastructure/broker.mjs';

test('runtime binding loads only current application references and can redact older deployed versions',async()=>{
 const id='sec_'+'a'.repeat(24),key={id,version:1,kind:'application',status:'active',sealed:'private-runtime-value',expiresAt:null};
 const records=new Map([['secret:'+id,key],['secret-version:'+id+':1',{...key}]]);
 const secrets=runtimeSecrets({store:{get:async(k,id)=>records.get(k+':'+id)},open:v=>v,now:()=>1000});
 const work={manifest:{secretBindings:[{secretId:id,version:1,envName:'MODEL_API_KEY'}]}};
 assert.deepEqual(await secrets.load(work),{MODEL_API_KEY:'private-runtime-value'});
 assert.equal((await secrets.redactor(work))('token=private-runtime-value'),'token=[redacted]');
 key.version=2;key.sealed='rotated-runtime-value';
 await assert.rejects(secrets.load(work),/inactive_or_changed/);
 assert.equal(await secrets.active(work),true);
 assert.equal((await secrets.redactor(work))('private-runtime-value'),'[redacted]');
 key.status='revoked';assert.equal(await secrets.active(work),false);
 await assert.rejects(secrets.load(work),/inactive_or_changed/);
 assert.throws(()=>runtimeBindings({manifest:{secretBindings:[{secretId:id,version:1,envName:'NEXT_PUBLIC_KEY'}]}}),/bindings_invalid/);
});

test('finished work revokes a worker grant without exposing the provider credential',async()=>{
 const id='sec_'+'b'.repeat(24),s={id,version:1,kind:'broker-grant',status:'active',rules:{workId:'nw_original'},sealed:'scoped-worker-key'};
 let state='working';const secrets=runtimeSecrets({store:{get:async()=>s},open:v=>v,workStatus:async()=>state});
 const work={manifest:{secretBindings:[{secretId:id,version:1,envName:'BROKER_KEY'}]}};
 assert.equal(await secrets.active(work),true);state='completed';assert.equal(await secrets.active(work),false);
 await assert.rejects(secrets.load(work),/inactive_or_changed/);
});

test('a release with application secrets requires verified owner scope at the custody boundary',async()=>{
 const work={projectId:'original',manifest:{releaseHash:digest('release'),image:'registry.example/image@'+digest('image'),secretBindings:[{secretId:'sec_'+'a'.repeat(24),envName:'MODEL_API_KEY',version:1}]}};
 const proof={approved:true,releaseId:work.manifest.releaseHash,projectId:work.projectId,image:work.manifest.image,manifestHash:digest(work.manifest),reviewHash:digest('review'),decisionHash:digest('decision')};
 assert.equal(await runtimeReleaseApproved(work,{request:async()=>Response.json(proof)}),false);
 assert.equal(await runtimeReleaseApproved(work,{request:async()=>Response.json({...proof,ownerSecretBindings:true})}),true);
 assert.equal(await runtimeReleaseApproved({...work,projectId:'foreign'},{request:async()=>Response.json({...proof,ownerSecretBindings:true})}),false);
});

test('Runpod receives the selected environment while its retained observation omits secret values',async()=>{
 let sent;
 const driver=runpodDriver({token:()=> 'fixture-provider-token',request:async(_url,init)=>{sent=JSON.parse(init.body);return Response.json({...sent,id:'pod123',status:'RUNNING',cost:0.1});}});
 const work={id:digest('work'),manifest:{image:'registry.example/image@'+digest('image'),region:'EU-RO-1',cpu:2,memoryMiB:4096,port:null,gpu:null,command:[]}};
 const observed=await driver.create(work,{bootDiskGiB:10,cpuType:'cpu'},{},{MODEL_API_KEY:'private-runtime-value'});
 assert.deepEqual(sent.env,{MODEL_API_KEY:'private-runtime-value'});
 assert.equal(observed.providerResourceId,'pod123');assert.equal(JSON.stringify(observed).includes('private-runtime-value'),false);
});
