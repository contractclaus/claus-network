import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './apps-fixture.mjs';
import {publishSite} from '../interfaces/site.mjs';
import {createPublicAppearances} from '../src/releases/appearance.mjs';
import {createProjects} from '../src/projects/index.mjs';
import {digest} from '../src/shared/index.mjs';

test('first project graph contains selected public artwork and tracks withdrawal', async t => {
  const {owner, project, advance, store} = await fixture(t);
  const site = await publishSite({client:owner, slug:project.slug, name:project.name, files:[
    {path:'index.html',content:'<!doctype html><title>Public site</title>'},
    {path:'logo.svg',content:'<svg xmlns="http://www.w3.org/2000/svg"/>'},
    {path:'claus.json',content:JSON.stringify({schema:'claus-project/1',name:'Public artwork',logo:'logo.svg',preview:'http://127.0.0.1/private'})}
  ]});
  const graph = () => owner.call('network_graph',{view:'projects'});
  let node = (await graph()).nodes.find(n=>n.id===project.id);
  assert.equal(node.presentation.name,'Public artwork');
  assert.equal(node.presentation.logo,site.siteUrl.replace('index.html','logo.svg'));
  assert.equal(node.presentation.preview,null);
  const fallback=createProjects({store,identity:{},publicAppearances:async()=>{throw Error('artwork temporarily unavailable');}});
  assert((await fallback.graph({view:'projects'})).nodes.some(n=>n.id===project.id));
  let state=await owner.call('release_get',{projectId:project.id,releaseId:site.releaseId});
  await owner.call('release_publish',{projectId:project.id,releaseId:site.releaseId,published:true,expiresAt:Date.now()+60000,expectedRevision:state.publication.revision});
  advance(120000);
  assert.equal((await graph()).nodes.find(n=>n.id===project.id).presentation,undefined);
  const p=await owner.call('project_get',{projectId:project.id});
  await owner.call('project_publish',{projectId:project.id,published:false,expectedRevision:p.publication.revision});
  assert(!(await graph()).nodes.some(n=>n.id===project.id));
});

test('appearance uses bounded batches and denies hidden, mismatched, expired or private sources', async () => {
  const ids=Array.from({length:100},(_,i)=>'p'+i),data=new Map(),calls=[];let time=100;
  const set=(collection,id,value)=>data.set(collection+':'+id,{value});
  for(const id of ids){
    const releaseId=digest({id}),snapshotId=digest({snapshot:id}),hash=digest({path:'claus.json',content:JSON.stringify({schema:'claus-project/1',logo:'logo.svg'})});
    set('project-site-selection',id,{releaseId});
    set('release-publications',releaseId,{projectId:id,published:true,expiresAt:1000});
    set('project-releases',releaseId,{id:releaseId,projectId:id,snapshotId,paths:['claus.json','logo.svg'],url:'https://claus-network-sites.vercel.app/r/'+releaseId.slice(7)+'/index.html'});
    set('snapshots',digest({projectId:id,id:snapshotId}),{projectId:id,files:[{path:'claus.json',hash}]});
    set('artifacts',digest({projectId:id,id:hash}),{projectId:id,path:'claus.json',hash,content:JSON.stringify({schema:'claus-project/1',logo:'logo.svg'})});
  }
  data.get('release-publications:'+digest({id:'p2'})).value.published=false;
  data.get('release-publications:'+digest({id:'p3'})).value.projectId='other';
  data.get('release-publications:'+digest({id:'p4'})).value.expiresAt=100;
  const store={readMany:async(c,keys)=>{calls.push({c,keys});return new Map(keys.map(id=>[id,data.get(c+':'+id)]));}};
  const appearances=createPublicAppearances({store,visibleMany:async all=>new Set(all.filter(id=>id!=='p1')),now:()=>time});
  const result=await appearances(ids);
  assert.equal(result.size,96);assert.equal(calls.length,6);
  for(const id of ['p1','p2','p3','p4'])assert(!result.has(id));
  assert(!calls[0].keys.includes('p1'));
  const read=store.readMany;store.readMany=async(c,keys)=>{const out=await read(c,keys);if(c==='artifacts')time=1000;return out;};
  assert.equal((await appearances(ids)).size,0);
});
