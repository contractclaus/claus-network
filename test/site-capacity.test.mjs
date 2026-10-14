import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './apps-fixture.mjs';
import {render} from '../hosting/render.mjs';
import {digest} from '../src/shared/index.mjs';

test('large multipage websites persist, serve selected files and honor withdrawal',async t=>{
 const {app,store,owner,bob,project,advance}=await fixture(t),projectId=project.id;
 const files=[{path:'index.html',content:'<!doctype html><a href="pages/about.html">About</a><canvas id="game"></canvas><script src="app.v2.js"></script>'},
  {path:'app.v2.js',content:'/*'+'x'.repeat(700000)+'*/document.querySelector("canvas").getContext("2d").fillRect(0,0,30,30);'},
  {path:'private.md',content:'not published'},
  ...Array.from({length:40},(_,i)=>({path:'pages/'+(i?'page-'+i:'about')+'.html',content:'<!doctype html><h1>Page '+i+'</h1>'}))];
 const snapshot=await owner.call('snapshot_create',{projectId,files,expectedProjectRevision:(await owner.call('project_get',{projectId})).revision});
 const paths=files.filter(f=>f.path!=='private.md').map(f=>f.path);
 const release=await owner.call('release_create',{projectId,snapshotId:snapshot.id,paths});
 await assert.rejects(bob.call('release_publish',{projectId,releaseId:release.id,published:true,expectedRevision:0}),e=>e.code==='scope_denied');
 const publication=await owner.call('release_publish',{projectId,releaseId:release.id,published:true,expectedRevision:0});
 assert.equal(publication.expiresAt,null);
 advance(366*86400000);
 const options={fetcher:(url,opt)=>app.fetch(new Request(url,opt),{peer:'host'})};
 for(const path of ['index.html','app.v2.js','pages/about.html']){
  const response=await render(new Request(release.url.replace('index.html',path)),options);
  assert.equal(response.status,200,path);assert.equal(await response.text(),files.find(f=>f.path===path).content);
  assert.match(response.headers.get('content-security-policy'),/connect-src 'none'/);
 }
 await assert.rejects(owner.call('public_release_file',{releaseId:release.id,filePath:'private.md'}),e=>e.code==='not_found');
 await assert.rejects(owner.call('public_release_file',{releaseId:release.id,filePath:'../index.html'}),e=>e.code==='invalid_file_path');
 const details=await owner.call('public_project',{slug:project.slug});assert(details.releases.some(r=>r.id===release.id));
 await owner.call('release_publish',{projectId,releaseId:release.id,published:false,expectedRevision:publication.revision});
 assert.equal((await render(new Request(release.url),options)).status,404);
 // Enlarged release capacity must not leave discovery stuck on its original first 100 rows.
 await store.transaction(async tx=>{for(let i=0;i<110;i++){
  const id=digest({i});await tx.write('project-releases',id,{...release,id},0);
  await tx.write('project-public-releases',projectId+':'+id,{releaseId:id,published:true,expiresAt:null},0);
 }});
 assert.equal((await app.releases.publicForProject(projectId)).length,110);
});
