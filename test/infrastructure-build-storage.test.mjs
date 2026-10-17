import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createOciBuildPlan,ociBuildArguments,ociBuildReceipt} from '../src/infrastructure/build-plan.mjs';
import {createR2Objects} from '../adapters/r2-objects.mjs';
import {errorBody,errorStatus} from '../interfaces/http.mjs';

test('OCI plan binds a multi-file snapshot, pinned base and dependency lock without claiming a build',()=>{
 const input={projectId:'project',snapshotId:'snapshot',files:[{path:'Dockerfile',content:'FROM docker.io/library/node@sha256:'+'a'.repeat(64)+'\nCOPY . /app\nWORKDIR /app\nRUN npm ci\nCMD ["node","server.mjs"]\n'},{path:'package.json',content:'{}'},{path:'package-lock.json',content:'{}'},{path:'server.mjs',content:'console.log("app")'}]};
 const plan=createOciBuildPlan(input);assert.equal(plan.evidence,'source_plan_only');
 const args=ociBuildArguments(plan,{context:'/work/context',output:'/out/image.tar',metadata:'/out/build.json'});
 assert(!args.includes('--push'));assert(!args.includes('--secret'));assert(!args.includes('--allow'));
 const receipt=ociBuildReceipt(plan,{metadata:{'containerimage.digest':'sha256:'+'b'.repeat(64)},runnerId:'isolated-runner',artifactHash:'sha256:'+'c'.repeat(64),artifactBytes:1024,exitCode:0});assert.equal(receipt.evidence,'compiled_only');
 const changed=structuredClone(plan);changed.source[0].content='FROM scratch';assert.throws(()=>ociBuildArguments(changed,{context:'/work',output:'/out',metadata:'/meta'}),{code:'oci_plan_changed'});
 assert.throws(()=>createOciBuildPlan({...input,files:input.files.filter(f=>f.path!=='package-lock.json')}),{code:'oci_package_lock_required'});
 assert.throws(()=>createOciBuildPlan({...input,files:[...input.files,{path:'../private',content:'secret'}]}),{code:'oci_path_invalid'});
});

test('R2 uses conditional content-addressed writes and verifies existing bytes without overwriting',async()=>{
 class PutObjectCommand{constructor(input){this.input=input;}}class GetObjectCommand{constructor(input){this.input=input;}}
 const sdk={PutObjectCommand,GetObjectCommand},objects=new Map();let writes=0,lost=false;
 const transport={async send(c){const i=c.input;
  if(c instanceof PutObjectCommand){writes++;assert.equal(i.IfNoneMatch,'*');if(objects.has(i.Key))throw {$metadata:{httpStatusCode:412}};objects.set(i.Key,Buffer.from(i.Body));if(lost)throw Error('lost response');return {};}
  const bytes=objects.get(i.Key);if(!bytes)throw {$metadata:{httpStatusCode:404}};return {ContentLength:bytes.length,Body:{async *[Symbol.asyncIterator](){yield bytes;}}};
 }};
 const store=await createR2Objects({accountId:'a'.repeat(32),bucket:'claus-assets',sdk,transport});
 const bytes=Buffer.from('encrypted-or-project-owned-data'),sha=createHash('sha256').update(bytes).digest('hex');
 const one=await store.put('project',bytes);assert.equal(one.state,'verified');assert.equal((await store.put('project',bytes)).key,one.key);
 assert.equal((await store.read('other-project',sha)).state,'not_found');await assert.rejects(store.read('../escape',sha),{code:'r2_object_reference_invalid'});
 lost=true;const other=Buffer.from('another original upload');const otherSha=createHash('sha256').update(other).digest('hex');
 await assert.rejects(store.put('project',other),{code:'r2_write_outcome_unknown'});const previousWrites=writes;
 assert.equal((await store.read('project',otherSha)).state,'verified');assert.equal(writes,previousWrites);
 objects.set(one.key,Buffer.from('corrupt'));await assert.rejects(store.read('project',sha),{code:'r2_object_integrity_failed'});
});

test('disabled infrastructure and invalid input are actionable and never advertised as retryable provider outages',()=>{
 assert.equal(errorStatus({code:'infrastructure_not_enabled'}),409);
 assert.equal(errorBody({code:'infrastructure_not_enabled'}).retryable,false);
 assert.equal(errorStatus({code:'oci_base_digest_required'}),400);
 assert.equal(errorStatus({code:'infrastructure_target_not_allowed'}),403);
});
