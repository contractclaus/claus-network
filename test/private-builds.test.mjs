import test from 'node:test';import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';import {createArtifactStore} from '../src/artifact-store/index.mjs';import {createJobs} from '../src/jobs/index.mjs';import {createOciBuilds} from '../src/infrastructure/builds.mjs';import {digest} from '../src/shared/index.mjs';
import {privateContextKey,openPrivateContext,sealPrivateContext} from '../src/infrastructure/private-context.mjs';
const secret='s'.repeat(64);
async function setup(t){
 const store=openStore(':memory:');t.after(()=>store.close());let at=1000000,allowed=true,published=false,calls=0;
 const files=[{path:'Dockerfile',content:'FROM scratch\nCOPY secret.txt /data.txt'},{path:'secret.txt',content:'UNPUBLISHED_PROJECT_CONTENT'}];
 const identity={authorize:async a=>assert.equal(a,'owner'),allowed:async()=>allowed};
 const projects={files:async()=>files,publicSource:async()=>{if(!published)throw Object.assign(Error('not_found'),{code:'not_found'});return{projectId:'p',snapshotId:'s',files};}};
 await store.transaction(async tx=>tx.write('snapshots',digest({projectId:'p',id:'s'}),{projectId:'p',id:'s',files:files.map(f=>({path:f.path,hash:digest(f.path)}))},0));
 const jobs=createJobs({store,identity,now:()=>at}),artifacts=createArtifactStore({store}),sourceFiles={get:async(_p,h)=>files.find(f=>digest(f.path)===h)};
 const ports={dispatch:async w=>{calls++;return{buildId:w.id,state:'running'};},inspect:async w=>({buildId:w.id,state:'compiled',runUrl:'https://github.com/contractclaus/claus-private-builds/actions/runs/1',receipt:{buildId:w.id,projectId:w.projectId,planId:w.planId,sourceHash:w.sourceHash,imageDigest:digest('image'),archiveHash:digest('archive'),archiveBytes:40*1024*1024,evidence:'compiled_only'}}),verify:async()=>true};
 const api=createOciBuilds({store,identity,projects,jobs,artifacts,sourceFiles,privateEnabled:true,privateSecret:secret,enabled:true,ports,now:()=>at});
 return{api,store,files,ports,input:{snapshotId:'s',sourceVisibility:'private',publishSource:false,idempotencyKey:'private'},advance:()=>at+=61000,revoke:()=>allowed=false,publish:()=>published=true,calls:()=>calls};
}
test('private source is encrypted and bound to its exact build without source publication',async t=>{
 const f=await setup(t),b=await f.api.submit('owner','p',f.input),capsule=await f.api.publicSource(b.id);assert.equal(b.publishSource,false);assert(!JSON.stringify(capsule).includes('UNPUBLISHED_PROJECT_CONTENT'));assert.equal(capsule.profile,'claus-private-context/1');
 const payload=openPrivateContext(privateContextKey(secret,capsule.scope),capsule);assert.equal(payload.plan.source.find(x=>x.path==='secret.txt').content,'UNPUBLISHED_PROJECT_CONTENT');
 const tampered=structuredClone(capsule);tampered.scope.projectId='other';assert.throws(()=>openPrivateContext(privateContextKey(secret,capsule.scope),tampered),/oci_private_context_invalid/);
});
test('private 40MiB image is retained under the same build identity and can be explicitly published without rebuilding',async t=>{
 const f=await setup(t),b=await f.api.submit('owner','p',f.input);await f.api.runOne();f.advance();await f.api.runOne();let current=await f.api.get('owner','p',b.id);assert.equal(current.state,'compiled');assert.equal(f.calls(),1);
 await assert.rejects(f.api.publish('owner','p',{buildId:b.id,publishSource:true,expectedRevision:current.revision}),{code:'not_found'});f.publish();
 await f.store.transaction(async tx=>tx.write('public-sources',digest({projectId:'p',id:'s'}),{projectId:'p',snapshotId:'s',published:true},0));
 current=await f.api.publish('owner','p',{buildId:b.id,publishSource:true,expectedRevision:current.revision});assert.equal(current.publishSource,true);assert.equal((await f.api.publicSource(b.id)).buildId,b.id);assert.equal(f.calls(),1);
});
test('revocation hides encrypted source and repeated private submissions keep one identity',async t=>{
 const f=await setup(t),b=await f.api.submit('owner','p',f.input);assert.equal((await f.api.submit('owner','p',f.input)).id,b.id);f.revoke();await assert.rejects(f.api.publicSource(b.id),{code:'not_found'});
});
test('private/public consent ambiguity and changed idempotency input are rejected',async t=>{
 const f=await setup(t);await assert.rejects(f.api.submit('owner','p',{...f.input,publishSource:true}),{code:'oci_public_source_consent_required'});
 await f.api.submit('owner','p',f.input);await assert.rejects(f.api.submit('owner','p',{...f.input,dockerfile:'Otherfile'}),{code:'idempotency_conflict'});
});
test('context ciphertext fails with another key or modified authentication tag',()=>{
 const scope={id:digest('id'),projectId:'p',planId:digest('plan'),sourceHash:digest('source')},payload={buildId:scope.id,plan:{id:scope.planId,projectId:scope.projectId,sourceHash:scope.sourceHash}};
 const c=sealPrivateContext(secret,scope,payload);assert.throws(()=>openPrivateContext(Buffer.alloc(32),c),/oci_private_context_invalid/);c.tag=Buffer.alloc(16).toString('base64');assert.throws(()=>openPrivateContext(privateContextKey(secret,scope),c),/oci_private_context_invalid/);
});
