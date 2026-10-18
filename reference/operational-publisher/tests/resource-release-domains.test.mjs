import test from 'node:test';import assert from 'node:assert/strict';
import {managedReleases} from '../src/resources/repository-releases.mjs';
import {managedDomains} from '../src/resources/project-domains.mjs';
import {team} from '../src/resources/providers.mjs';
function memory(){
 const values=new Map(),key=(k,id)=>k+':'+id;
 return {values,get:async(k,id)=>structuredClone(values.get(key(k,id))??null),
  async put(k,id,v){const exists=values.has(key(k,id));if(!exists)values.set(key(k,id),structuredClone(v));return {created:!exists,value:structuredClone(values.get(key(k,id)))};},
  async change(k,id,revision,v){assert.equal(values.get(key(k,id)).revision,revision);values.set(key(k,id),structuredClone(v));return v;},
  async begin(id,operation,input,prepared){const {created,value}=await this.put('action',id,{operation,input,prepared,phase:'prepared'});assert.deepEqual(value.input,input);return {created,row:{result:value}};},
  async dispatch(id){const v=values.get(key('action',id));if(v.phase!=='prepared')return false;v.phase='dispatched';return true;},
  async complete(id,output){values.get(key('action',id)).output=structuredClone(output);return output;},
  async deferRejected(id,retryAt){Object.assign(values.get(key('action',id)),{phase:'provider_retry',retryAt});}
 };
}
async function repositoryFixture(){
 const store=memory(),r={id:'res_'+'1'.repeat(24),provider:'github',owner:'contractclaus',providerId:'42',name:'claus-product'},sha='a'.repeat(40);await store.put('resource',r.id,r);
 let release=null,tag=null,posts=0,lose=true,comparison='ahead',head='b'.repeat(40);
 const call=async(provider,path,{method='GET',body}={})=>{
  assert.equal(provider,'github');const prefix='/repos/contractclaus/claus-product';assert(path.startsWith(prefix));const p=path.slice(prefix.length);
  if(!p)return {id:42,owner:{login:'contractclaus'}};
  if(p==='/git/commits/'+sha)return {sha};
  if(p.startsWith('/git/ref/tags/'))return tag?{object:{type:'commit',sha:tag}}:null;
  if(p.startsWith('/releases?'))return release?[release]:[];
  if(p==='/releases'&&method==='POST'){posts++;release={id:7,tag_name:body.tag_name,target_commitish:body.target_commitish,name:body.name,body:body.body,prerelease:body.prerelease,draft:true,created_at:'2026-10-18T00:00:00Z',updated_at:'2026-10-18T00:00:00Z',html_url:'https://github.com/contractclaus/claus-product/releases/tag/v1'};if(lose){lose=false;throw Error('lost response');}return release;}
  if(p==='/releases/7'){if(method==='PATCH'){release={...release,draft:false};tag=sha;}return release;}
  if(p.startsWith('/compare/'))return {status:comparison};
  if(p==='/git/ref/heads/main')return {object:{sha:head}};
  if(p==='/git/refs/heads/main'&&method==='PATCH'){assert.equal(body.force,false);head=body.sha;return {object:{sha:head}};}
  throw Error('Unexpected '+method+' '+p);
 };
 return {store,r,sha,api:managedReleases({store,call}),posts:()=>posts,setTag:v=>tag=v,diverge:()=>comparison='diverged'};
}
test('lost draft response reconciles the original release, then publishes the pinned tag once',async()=>{
 const f=await repositoryFixture(),input={resourceId:f.r.id,tag:'v1',commit:f.sha,title:'Product v1',body:'Implements the requested product.',prerelease:false};
 await assert.rejects(f.api.call('repository_release_prepare',input,'release-original'),/lost response/);
 const draft=await f.api.call('repository_release_prepare',input,'release-original');assert.equal(f.posts(),1);assert.equal(draft.release.draft,true);
 const publish={resourceId:f.r.id,releaseId:draft.release.id,expectedUpdatedAt:draft.release.updatedAt};
 const live=await f.api.call('repository_release_publish',publish,'publish-original');assert.equal(live.published,true);assert.equal(live.sourceCommit,f.sha);
 assert.deepEqual(await f.api.call('repository_release_publish',publish,'publish-original'),live);
 await assert.rejects(f.api.call('repository_release_prepare',{...input,commit:'c'.repeat(40)},'release-original'),/request_conflict/);
});
test('existing tags and divergent branches cannot silently replace history',async()=>{
 const f=await repositoryFixture();f.setTag('c'.repeat(40));
 await assert.rejects(f.api.call('repository_release_prepare',{resourceId:f.r.id,tag:'v1',commit:f.sha,title:'v1',body:'Notes',prerelease:false},'tag-check'),/tag_commit_changed/);
 f.diverge();await assert.rejects(f.api.call('repository_fastforward',{resourceId:f.r.id,branch:'main',expectedCommit:'b'.repeat(40),commit:f.sha},'branch-check'),/fastforward_required/);assert.equal(f.posts(),0);
});
test('owned project domain recovers unknown create, verifies proof and removes only its hosting binding',async()=>{
 const store=memory(),r={id:'res_'+'2'.repeat(24),provider:'vercel',providerId:'prj_owned',owner:team};await store.put('resource',r.id,r);
 let domain=null,creates=0,lose=true,deleted=0;
 const call=async(provider,path,{method='GET',body}={})=>{
  assert.equal(provider,'vercel');if(path==='/v9/projects/prj_owned')return {id:r.providerId,accountId:team};
  if(path==='/v10/projects/prj_owned/domains'){creates++;domain={name:body.name,projectId:r.providerId,verified:false,createdAt:10,updatedAt:10,verification:[{type:'TXT',domain:'_vercel.product.claus.si',value:'domain-ownership-proof'}]};if(lose){lose=false;throw Error('lost domain response');}return domain;}
  if(path.endsWith('/verify')){domain={...domain,verified:true,updatedAt:11};return domain;}
  if(path.startsWith('/v9/projects/prj_owned/domains/')){if(method==='DELETE'){assert.equal(body.removeRedirects,false);deleted++;domain=null;}return domain;}
  if(path.startsWith('/v6/domains/'))return {misconfigured:false};throw Error('Unexpected '+path);
 };
 const api=managedDomains({store,call}),input={resourceId:r.id,domain:'product.claus.si'};
 await assert.rejects(api.call('project_domain_add',input,'domain-original'),/lost domain response/);
 const added=await api.call('project_domain_add',input,'domain-original');assert.equal(creates,1);assert.equal(added.binding.verified,false);
 const verified=await api.call('project_domain_verify',input,'verify-original');assert.equal(verified.state,'ownership_verified');
 await assert.rejects(api.call('project_domain_remove',{...input,expectedVersion:'stale'},'remove-stale'),/binding_changed/);
 const removed=await api.call('project_domain_remove',{...input,expectedVersion:verified.binding.version},'remove-original');assert.equal(removed.dnsRecordsChanged,false);assert.equal(deleted,1);
 await assert.rejects(api.call('project_domain_add',{...input,domain:'www.claus.si'},'protected'),/outside_owned_subdomains/);
 await assert.rejects(api.call('project_domain_add',{...input,domain:'foreign.example'},'foreign'),/outside_owned_subdomains/);
});
