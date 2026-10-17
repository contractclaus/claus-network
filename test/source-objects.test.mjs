import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {openStore} from '../src/storage/index.mjs';
import {createApplication} from '../runtime/server.mjs';
import {createSourceFiles} from '../src/artifact-store/index.mjs';
import {digest} from '../src/shared/index.mjs';
import {archiveKeyId, createProjectArchives, verifyProjectArchive} from '../src/portability/index.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function bucket() {
 const data = new Map(), calls = {put:0,read:0};
 return {data,calls,
  async put(projectId, bytes) {calls.put++;const hash=sha(bytes);data.set(projectId+':'+hash,Buffer.from(bytes));return {state:'verified',sha256:hash,bytes:bytes.length};},
  async read(projectId, hash) {calls.read++;const bytes=data.get(projectId+':'+hash);return bytes?{state:'verified',bytes,length:bytes.length}:{state:'not_found'};}
 };
}
async function fixture(t, objects=bucket()) {
 const store=openStore(':memory:');t.after(()=>store.close());
 const app=createApplication({store,sourceObjects:objects,rateSalt:'source-test'.repeat(5)});
 const owner=privateKeyToAccount(generatePrivateKey()), challenge=await app.identity.challenge({address:owner.address});
 const session=await app.identity.session({challengeId:challenge.id,signature:await owner.signMessage({message:challenge.message})});
 const actor=await app.identity.authenticate(session.token);
 const project=await app.identity.createProject(actor,{slug:'r2-website',name:'R2 website',idempotencyKey:'first'});
 return {app,store,owner,actor,project,objects};
}
test('large source is external, manifests stay inline, retry preserves snapshot and uses no second put',async t=>{
 const f=await fixture(t), content='<html>'+ 'x'.repeat(6000)+'</html>', files=[{path:'index.html',content},{path:'claus.json',content:'{}'}];
 const snap=await f.app.projects.createSnapshot(f.actor,f.project.id,{files,expectedProjectRevision:1});
 const row=(await f.store.read('artifacts',digest({projectId:f.project.id,id:digest(files[0])}))).value;
 assert.equal(row.object.kind,'r2-source-v1');assert.equal(row.content,undefined);assert.equal(f.objects.calls.put,1);
 const again=await f.app.projects.createSnapshot(f.actor,f.project.id,{files,expectedProjectRevision:1});assert.equal(again.id,snap.id);assert.equal(f.objects.calls.put,1);
 const fresh=createSourceFiles({store:f.store,objects:f.objects});assert.equal((await fresh.get(f.project.id,row.hash)).content,content);
 await assert.rejects(fresh.get('foreign',row.hash),{code:'not_found'});
 const reads=f.objects.calls.read;await fresh.get(f.project.id,row.hash);assert.equal(f.objects.calls.read,reads);
});
test('unprivileged/stale snapshots never write R2 and uncertain upload publishes no partial snapshot',async t=>{
 const f=await fixture(t), input={files:[{path:'index.html',content:'a'.repeat(5000)}],expectedProjectRevision:2};
 await assert.rejects(f.app.projects.createSnapshot(f.actor,f.project.id,input),{code:'revision_conflict'});assert.equal(f.objects.calls.put,0);
 await assert.rejects(f.app.projects.createSnapshot({},f.project.id,{...input,expectedProjectRevision:1}));assert.equal(f.objects.calls.put,0);
 f.objects.put=async()=>{throw Object.assign(Error('unknown'),{code:'r2_write_outcome_unknown'});};
 await assert.rejects(f.app.projects.createSnapshot(f.actor,f.project.id,{...input,expectedProjectRevision:1}),{code:'r2_write_outcome_unknown'});
 assert.equal((await f.store.list('snapshots')).length,0);assert.equal((await f.store.list('artifacts')).length,0);
});
test('published file uses R2 after a cold start, source stays private, export is self-contained',async t=>{
 const f=await fixture(t), content='<html>'+'c'.repeat(7000)+'</html>', files=[{path:'index.html',content},{path:'private.md',content:'PRIVATE'.repeat(1000)}];
 const snapshot=await f.app.projects.createSnapshot(f.actor,f.project.id,{files,expectedProjectRevision:1});
 await f.store.transaction(async tx=>{await tx.write('network-capabilities','collaboration',{enabled:true},0);await tx.write('review-pilots',f.project.id,{enabled:true,expiresAt:Date.now()+86400000},0);});
 const release=await f.app.releases.create(f.actor,f.project.id,{snapshotId:snapshot.id,paths:['index.html']});
 await f.app.releases.publish(f.actor,f.project.id,{releaseId:release.id,published:true,expiresAt:Date.now()+60000,expectedRevision:0});
 const cold=createApplication({store:f.store,sourceObjects:f.objects,rateSalt:'source-test'.repeat(5)});
 assert.equal((await cold.releases.file(release.id,'index.html')).file.content,content);
 await assert.rejects(cold.releases.file(release.id,'private.md'),{code:'not_found'});
 const keys=generateKeyPairSync('ed25519'),operatorId='https://archive.example';
 const archives=createProjectArchives({store:f.store,identity:f.app.identity,sourceFiles:cold.sourceFiles,operatorId,signingKey:keys.privateKey});
 const archive=await archives.export(f.actor,f.project.id),verified=verifyProjectArchive(archive,{trustedOperators:{[operatorId]:{[archiveKeyId(keys.publicKey)]:keys.publicKey}},expectedOwner:{address:f.owner.address,chainId:1}});
 const exported=verified.records.filter(r=>r.collection==='artifacts');assert.equal(exported.length,2);assert(exported.every(r=>typeof r.value.content==='string'&&!r.value.object));
 const local=createSourceFiles({store:f.store});for(const r of exported)assert.equal((await local.resolve(r.value)).hash,r.value.hash);
 await f.app.releases.publish(f.actor,f.project.id,{releaseId:release.id,published:false,expiresAt:0,expectedRevision:1});
 await assert.rejects(cold.releases.file(release.id,'index.html'),{code:'not_found'});
});
test('cross-project, missing and corrupted object bytes fail; a legacy source still reads',async t=>{
 const f=await fixture(t), original={projectId:f.project.id,path:'large.txt',content:'d'.repeat(5000)}, file={...original,hash:digest({path:original.path,content:original.content})};
 const stored=await f.app.sourceFiles.prepare(f.project.id,file), fresh=()=>createSourceFiles({store:f.store,objects:f.objects});
 assert.equal((await fresh().resolve(file)).content,file.content);
 await assert.rejects(fresh().resolve({...stored,projectId:'foreign'}),{code:'artifact_corrupt'});
 f.objects.data.set(f.project.id+':'+stored.object.sha256,Buffer.from('broken'));await assert.rejects(fresh().resolve(stored),{code:'artifact_corrupt'});
 await assert.rejects(createSourceFiles({store:f.store}).resolve(stored),{code:'source_storage_unavailable'});
});
