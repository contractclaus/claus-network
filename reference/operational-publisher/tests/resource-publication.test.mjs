import test from 'node:test';import assert from 'node:assert/strict';
import {managedPublishing} from '../src/resources/publishing.mjs';
import {createHash} from 'node:crypto';
test('upload continuation and a lost build response retain one deployment; promotion verifies source',async()=>{
 const rows=new Map();let clock=0,production='dpl_old',builds=0,dispatched=false,uploadCalls=0,wrong=false,promotes=0;
 const r={id:'res_app',provider:'vercel',providerId:'prj_app',name:'claus-app'},repo={id:'res_repo'};
 const source={commit:'a'.repeat(40),files:[{path:'index.html',size:1,gitSha:'1'},{path:'vercel.json',size:1,gitSha:'2'}]};
 const hashes=[1,2].map(n=>createHash('sha1').update(Buffer.from([n])).digest('hex'));let deployed;
 const store={async get(k,id){return structuredClone(rows.get(k+':'+id)??null);},async put(k,id,v){if(!rows.has(k+':'+id))rows.set(k+':'+id,structuredClone(v));},async change(k,id,revision,v){assert.equal(rows.get(k+':'+id).revision,revision);rows.set(k+':'+id,structuredClone(v));}};
 const charges=[];const call=async(provider,path,options={})=>{
  if(path==='/v9/projects/prj_app')return {id:'prj_app',accountId:'team_uolDmrwvORBaI3V7q4JVMKNS',resourceConfig:{buildMachineType:'basic'},targets:{production:{id:production}}};
  if(path.startsWith('/v6/deployments?'))return {deployments:deployed?[{...deployed,uid:deployed.id}]:[]};
  if(path.startsWith('/v13/deployments?')){builds++;deployed={id:'dpl_new',url:'claus-app.vercel.app',projectId:'prj_app',readyState:'READY',meta:options.body.meta};assert.equal(options.body.autoAssignCustomDomains,false);throw Error('lost_response');}
  if(path==='/v13/deployments/dpl_new')return deployed;
  if(path==='/v6/deployments/dpl_new/files')return [{name:'src',children:source.files.map((f,i)=>({name:f.path,uid:wrong?'wrong':hashes[i]}))}];
  if(path==='/v10/projects/prj_app/promote/dpl_new'){promotes++;production='dpl_new';return {};}
  throw Error(path);
 };
 const publishing=managedPublishing({call,store,budget:async(...args)=>charges.push(args),repository:{repositoryTree:async()=>source,repositoryBlob:async(r,f)=>Buffer.from([Number(f.gitSha)])},now:()=>clock,token:()=> 'test',request:async(url,options)=>{if(url.includes('/v2/files')){uploadCalls++;clock+=50000;}return new Response('',{status:200});}});
 const prepared=await publishing.prepare(r,repo,{commit:source.commit,expectedDeploymentId:'dpl_old'}),dispatch=async()=>{if(dispatched)return false;dispatched=true;return true;};
 const partial=await publishing.stage(prepared,'act_original',dispatch);assert.equal(partial.pending,true);assert.equal(partial.uploadedFiles,1);assert.equal(builds,0);
 await assert.rejects(publishing.stage(prepared,'act_original',dispatch),/lost_response/);assert.equal(builds,1);
 const recovered=await publishing.stage(prepared,'act_original',dispatch);assert.equal(builds,1);assert.equal(uploadCalls,2);assert.equal(recovered.deployment.id,'dpl_new');assert.deepEqual(charges.map(x=>x[0]),['reserve','commit']);
 await store.put('publication','dpl_new',{resourceId:r.id,actionId:'act_original',sourceHash:prepared.sourceHash});
 wrong=true;await assert.rejects(publishing.promote(r,{deploymentId:'dpl_new',expectedDeploymentId:'dpl_old',healthPath:'/'},'promote',async()=>true),/source_manifest_changed/);assert.equal(promotes,0);
 wrong=false;assert.equal((await publishing.promote(r,{deploymentId:'dpl_new',expectedDeploymentId:'dpl_old',healthPath:'/'},'promote',async()=>true)).promoted,true);assert.equal(promotes,1);
});
