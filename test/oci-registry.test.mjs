import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openStore} from '../src/storage/index.mjs';
import {readOciLayout} from '../src/infrastructure/oci-layout.mjs';
import {createImageRegistry} from '../src/infrastructure/registry.mjs';
import {createImageArchive} from '../src/infrastructure/image-archive.mjs';
import {digest} from '../src/shared/index.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
function tar(files){
 const parts=[];for(const [path,bytes] of files){const h=Buffer.alloc(512);h.write(path);h.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);h[156]=48;h.fill(32,148,156);const sum=h.reduce((a,b)=>a+b,0);h.write(sum.toString(8).padStart(6,'0')+'\0 ',148);parts.push(h,bytes,Buffer.alloc((512-bytes.length%512)%512));}return Buffer.concat([...parts,Buffer.alloc(1024)]);
}
function fixture(){
 const files=[];
 function blob(value,mediaType){const b=Buffer.from(typeof value==='string'?value:JSON.stringify(value)),d={mediaType,digest:'sha256:'+hash(b),size:b.length};files.push(['blobs/sha256/'+hash(b),b]);return d;}
 const config=blob('{}','application/vnd.oci.image.config.v1+json'),layer=blob('a layer','application/vnd.oci.image.layer.v1.tar');
 const manifest=blob({schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config,layers:[layer]},'application/vnd.oci.image.manifest.v1+json');
 files.push(['index.json',Buffer.from(JSON.stringify({schemaVersion:2,manifests:[manifest]}))],['oci-layout',Buffer.from('{"imageLayoutVersion":"1.0.0"}')]);return {files,archive:tar(files),manifest,layer};
}
test('OCI graph validates bytes, paths and root; unreferenced blobs are not published',()=>{
 const f=fixture(),extra=Buffer.from('unrelated secret');f.files.push(['blobs/sha256/'+hash(extra),extra]);
 const layout=readOciLayout(tar(f.files),f.manifest.digest);assert.equal(layout.members.length,3);assert(!layout.members.some(x=>x.digest==='sha256:'+hash(extra)));
 const corrupt=f.files.map(([n,b],i)=>[n,i===1?Buffer.from('a Layer'):b]);assert.throws(()=>readOciLayout(tar(corrupt),f.manifest.digest),/oci_layout_invalid/);
 assert.throws(()=>readOciLayout(tar([...f.files,['../escape',extra]]),f.manifest.digest),/oci_layout_invalid/);
 assert.throws(()=>readOciLayout(f.archive,'sha256:'+'a'.repeat(64)),/oci_layout_invalid/);
});
test('lost image publication acknowledgement recovers hashed objects, not a new build',async()=>{
 const f=fixture(),data=new Map(),receipt={archiveHash:'sha256:'+hash(f.archive),archiveBytes:f.archive.length,imageDigest:f.manifest.digest,storage:{state:'verified'}};let lost=true,writes=0;
 const objects={read:async(ns,key)=>ns.startsWith('oci-')?{state:'verified',length:f.archive.length,bytes:f.archive}:data.has(ns+key)?{state:'verified',length:data.get(ns+key).length,bytes:data.get(ns+key)}:{state:'not_found'},put:async(ns,b)=>{writes++;data.set(ns+hash(b),b);if(lost){lost=false;throw Error('lost');}return {state:'verified',sha256:hash(b),bytes:b.length};}};
 const images=createImageArchive({objects});await assert.rejects(images.publish('project',receipt),/lost/);const layout=await images.publish('project',receipt);assert.equal(writes,3);assert.equal(layout.members.length,3);
});
test('publication is revision-bound and withdrawable; registry refuses hidden source and undeclared blobs',async t=>{
 const f=fixture(),store=openStore(':memory:');t.after(()=>store.close());const buildId=digest('build'),projectId='project',receipt={buildId,projectId,planId:digest('plan'),sourceHash:digest('source')};let active=true,publicSource=true,publishes=0;
 const identity={authorize:async(a,_p,{projectId:p})=>assert(a==='owner'&&p===projectId),allowed:async()=>active};
 await store.transaction(async tx=>{await tx.write('oci-builds',buildId,{...receipt,id:buildId,actor:'owner',publishSource:true,snapshotId:digest('snapshot'),state:'compiled',artifactHash:digest('artifact')},0);await tx.write('workflow-jobs',buildId,{state:'complete'},0);});
 const registry=createImageRegistry({store,identity,projects:{publicSource:async()=>{if(!publicSource)throw Object.assign(Error('not_found'),{code:'not_found'});return {projectId,snapshotId:digest('snapshot')};}},artifacts:{get:async()=>receipt},images:{enabled:true,publish:async()=>{publishes++;return {...readOciLayout(f.archive,f.manifest.digest),members:readOciLayout(f.archive,f.manifest.digest).members.map(({bytes,...m})=>m)};},registryRead:async(_p,m)=>m.manifest?{bytes:f.files.find(([n])=>n.endsWith(m.digest.slice(7)))[1]}:{url:'https://example.com/blob'}},origin:'https://api.example.com'});
 const url=(kind,d)=>`https://api.example.com/v2/claus/${buildId.slice(7)}/${kind}/${d}`;
 assert.equal((await registry.handle(new Request(url('manifests',f.manifest.digest)))).status,404);
 const published=await registry.publish('owner',projectId,{buildId,publishImage:true,expectedRevision:1});assert(published.image.startsWith('api.example.com/claus/'));assert.equal(publishes,1);
 assert.equal((await registry.handle(new Request(url('manifests',f.manifest.digest)))).status,200);
 assert.equal((await registry.handle(new Request(url('blobs',f.layer.digest)))).status,307);
 assert.equal((await registry.handle(new Request(url('blobs','sha256:'+'b'.repeat(64))))).status,404);
 publicSource=false;assert.equal((await registry.handle(new Request(url('manifests',f.manifest.digest)))).status,404);publicSource=true;
 active=false;assert.equal((await registry.handle(new Request(url('manifests',f.manifest.digest)))).status,404);active=true;
 await assert.rejects(registry.publish('owner',projectId,{buildId,publishImage:true,expectedRevision:1}),/revision_conflict/);
 await registry.publish('owner',projectId,{buildId,publishImage:false,expectedRevision:published.revision});assert.equal((await registry.handle(new Request(url('blobs',f.layer.digest)))).status,404);
 assert.equal((await registry.handle(new Request(url('blobs',f.layer.digest),{method:'DELETE'}))).status,405);
});

test('registry rewrites preserve the public path without accepting arbitrary destinations',async()=>{
 const {requestUrl}=await import('../runtime/request-url.mjs');
 for(const path of ['/v2','/v2/','/v2/claus/abc/manifests/sha256:abc'])assert.equal(requestUrl('/api/gateway?__claus_route='+encodeURIComponent(path),'https://claus.si').pathname,path);
 assert.equal(requestUrl('/api/gateway?__claus_route=https://foreign.test','https://claus.si').pathname,'/api/gateway');
});
