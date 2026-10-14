import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './apps-fixture.mjs';
import {createProjects} from '../src/projects/index.mjs';
import {publishSite} from '../interfaces/site.mjs';
import {render} from '../hosting/render.mjs';
import {connectSources} from '../src/shared/index.mjs';

test('compact discovery does not fetch detailed resources and still honors holds and withdrawal',async t=>{
  const {store,owner,project}=await fixture(t);
  const compact=createProjects({store,identity:{},publicDetails:()=>{throw Error('slow detailed services must not run');},visibleMany:async ids=>new Set(ids.filter(id=>id!==project.id))});
  let graph=await compact.graph({view:'projects'});assert(!graph.nodes.some(p=>p.id===project.id));
  const visible=createProjects({store,identity:{},publicDetails:()=>{throw Error('no');}});
  graph=await visible.graph({view:'projects'});assert(graph.nodes.some(p=>p.id===project.id));
  const p=await owner.call('project_get',{projectId:project.id});
  await owner.call('project_publish',{projectId:project.id,published:false,expectedRevision:p.publication.revision});
  assert(!(await visible.graph({view:'projects'})).nodes.some(p=>p.id===project.id));
});

test('public website helper resumes the same multipage release and supplies its map link',async t=>{
  const {owner,project,app}=await fixture(t);
  const input={client:owner,slug:project.slug,name:project.name,files:[
    {path:'index.html',content:'<!doctype html><a href="pages/about.html">About</a><script src="app.js"></script>'},
    {path:'pages/about.html',content:'<!doctype html><h1>About</h1>'},
    {path:'app.js',content:'fetch("https://api.open-meteo.com/v1/forecast?latitude=47&longitude=8&current=temperature_2m",{credentials:"omit"})'},
    {path:'claus.json',content:JSON.stringify({schema:'claus-project/1',connect:['https://api.open-meteo.com']})}
  ]};
  const one=await publishSite(input),two=await publishSite(input);assert.deepEqual(two,one);
  assert(one.mapUrl.endsWith('#project='+project.slug));
  const response=await render(new Request(one.siteUrl),{fetcher:(url,opts)=>app.fetch(new Request(url,opts),{peer:'host'})});
  const policy=response.headers.get('content-security-policy');assert.match(policy,/connect-src https:\/\/api.open-meteo.com;/);
  assert(!policy.includes('allow-same-origin'));assert(!policy.includes('allow-forms'));assert.match(policy,/frame-src 'none'/);
  assert.equal(response.headers.get('access-control-allow-credentials'),null);
  const state=await owner.call('release_get',{projectId:project.id,releaseId:one.releaseId});
  const expiresAt=Date.now()+3600000;
  await owner.call('release_publish',{projectId:project.id,releaseId:one.releaseId,published:true,expiresAt,expectedRevision:state.publication.revision});
  assert.equal((await publishSite(input)).expiresAt,expiresAt);
});

test('only explicitly public GET calls accept a sandboxed browser origin',async t=>{
  const {app}=await fixture(t);
  const publicRead=await app.fetch(new Request('https://claus.si/v1/public/graph?view=projects',{headers:{origin:'null'}}),{peer:'browser'});
  assert.equal(publicRead.status,200);assert.equal(publicRead.headers.get('access-control-allow-origin'),'*');
  const protectedRead=await app.fetch(new Request('https://claus.si/v1/projects',{headers:{origin:'null'}}),{peer:'browser'});
  assert.equal(protectedRead.status,403);assert.equal(protectedRead.headers.get('access-control-allow-origin'),null);
  for(const url of ['http://example.com','https://127.0.0.1','https://user:pass@example.com','https://example.com/*','https://example.com; script-src *','https://localhost','https://foo.local'])assert.throws(()=>connectSources([url]));
});

test('website helper does not report an older release as the active project website',async t=>{
  const {owner,project,advance}=await fixture(t);
  const base={client:owner,slug:project.slug,name:project.name};
  const old={...base,files:[{path:'index.html',content:'<!doctype html><h1>Version A</h1>'}]};
  await publishSite(old);advance(1000);
  const latest=await publishSite({...base,files:[{path:'index.html',content:'<!doctype html><h1>Version B</h1>'}]});
  await assert.rejects(publishSite(old),/active project website/);
  const actual=await owner.call('public_project',{slug:project.slug});
  assert.equal(actual.releases.sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id))[0].id,latest.releaseId);
});
