import test from 'node:test';import assert from 'node:assert/strict';
import {createProjects} from '../src/projects/index.mjs';
import {createReleases} from '../src/releases/index.mjs';

test('appearance uses the same publication, hold and archive gates without loading unrelated data',async()=>{
 let published=true,visible=true,archived=false;const calls=[];
 const store={read:async(c)=>{calls.push(c);if(c==='public-projects')return {revision:3,value:{projectId:'prj_one',slug:'one',published}};if(c==='projects')return {value:{archivedAt:archived?1:null}};throw Error('unrelated read');}};
 const api=createProjects({store,identity:{},visible:async()=>visible,publicDetails:async()=>{throw Error('full details');},publicAppearance:async()=>({releases:[{id:'release'}]})});
 assert.deepEqual((await api.publicProject('one',{view:'appearance'})).releases,[{id:'release'}]);assert.deepEqual(calls,['public-projects','projects']);
 for(const state of ['unpublished','held','archived']){published=state!=='unpublished';visible=state!=='held';archived=state==='archived';await assert.rejects(api.publicProject('one',{view:'appearance'}),{code:'not_found'});}
});
test('release list batches only current allowed releases and rechecks expiry after IO',async()=>{
 let now=100,override=null,batches=[];const rows=[{releaseId:'a',published:true,expiresAt:200},{releaseId:'b',published:true,expiresAt:null},{releaseId:'c',published:false,expiresAt:null},{releaseId:'d',published:true,expiresAt:90}];
 const store={read:async c=>{assert.equal(c,'content-controls');return {value:{releaseId:override}};},list:async()=>rows.map(value=>({value})),readMany:async(c,ids)=>{assert.equal(c,'project-releases');batches.push(ids);return new Map(ids.map(id=>[id,{value:{id,projectId:'p',createdAt:1}}]));}};
 const api=createReleases({store,identity:{},projects:{},artifacts:{},now:()=>now});
 assert.deepEqual((await api.publicForProject('p')).map(r=>r.id),['a','b']);assert.deepEqual(batches,[['a','b']]);
 override='b';assert.deepEqual((await api.publicForProject('p')).map(r=>r.id),['b']);
 override=null;const original=store.readMany;store.readMany=async(...args)=>{const result=await original(...args);now=200;return result;};assert.deepEqual((await api.publicForProject('p')).map(r=>r.id),['b']);
});
