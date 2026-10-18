import {digest} from './store.mjs';
const fail=c=>{throw Error('resource_repository_'+c);};
const commit=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const ref=v=>typeof v==='string'&&v.length>0&&v.length<=180&&/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(v)&&!v.includes('..')&&!v.includes('//')&&!v.endsWith('/')&&!v.endsWith('.')&&!v.endsWith('.lock');
const clean=(v,n)=>typeof v==='string'&&v.trim().length>0&&v.length<=n&&!/-----BEGIN|Bearer\s+[A-Za-z0-9]|(?:password|token|secret|api[-_]?key)\s*[=:]\s*\S{8}/i.test(v);
const releaseView=r=>({id:r.id,tag:r.tag_name,title:r.name,body:r.body,draft:r.draft,prerelease:r.prerelease,immutable:r.immutable===true,target:r.target_commitish,url:r.html_url,createdAt:r.created_at,updatedAt:r.updated_at,publishedAt:r.published_at,instructionAuthority:false,assets:(r.assets??[]).map(a=>({name:a.name,bytes:a.size,digest:a.digest??null,url:a.browser_download_url}))});
export const releaseInputs={repository_branches:['resourceId','page'],repository_fastforward:['resourceId','branch','expectedCommit','commit'],repository_releases:['resourceId','page'],repository_release:['resourceId','releaseId'],repository_release_prepare:['resourceId','tag','commit','title','body','prerelease'],repository_release_publish:['resourceId','releaseId','expectedUpdatedAt']};

export function managedReleases({store,call,now=Date.now}){
 const api=(path,options)=>call('github',path,options);
 async function repository(id){
  const r=await store.get('resource',id);
  if(!r||r.protected||r.provider!=='github'||r.owner!=='contractclaus'||!/^claus-[a-z0-9-]+$/.test(r.name))fail('scope_invalid');
  const prefix='/repos/contractclaus/'+r.name,current=await api(prefix);
  if(String(current.id)!==r.providerId||current.owner?.login!=='contractclaus')fail('owner_changed');
  return {...r,prefix};
 }
 async function resolve(r,tag){
  let row=await api(r.prefix+'/git/ref/tags/'+encodeURIComponent(tag),{missing:true});if(!row)return null;
  for(let i=0;i<8;i++){
   if(row.object?.type==='commit'&&commit(row.object.sha))return row.object.sha;
   if(row.object?.type!=='tag'||!commit(row.object.sha))fail('tag_invalid');
   row=await api(r.prefix+'/git/tags/'+row.object.sha);
  }
  fail('tag_depth');
 }
 async function byTag(r,tag){
  for(let page=1;page<=100;page++){
   const rows=await api(r.prefix+'/releases?per_page=100&page='+page);
   const found=rows.filter(v=>v.tag_name===tag);if(found.length>1)fail('ambiguous_release');if(found.length)return found[0];if(rows.length<100)return null;
  }
  fail('release_pagination_required');
 }
 async function dispatch(id,run){
  if(!await store.dispatch(id))return;
  try{return await run();}
  catch(e){if(e.status===429){e.retryAt=Math.max(now()+1000,e.retryAt??now()+300000);await store.deferRejected(id,new Date(e.retryAt).toISOString());}throw e;}
 }
 async function callRelease(operation,input,requestId){
  const r=await repository(input.resourceId);
  if(operation==='repository_releases'||operation==='repository_branches'){
   const page=input.page??1;if(!Number.isSafeInteger(page)||page<1||page>10000)fail('page_invalid');
   const releases=operation==='repository_releases',rows=await api(r.prefix+(releases?'/releases':'/branches')+'?per_page=100&page='+page);
   return {items:releases?rows.map(releaseView):rows.map(v=>({name:v.name,commit:v.commit.sha,protected:v.protected})),nextPage:rows.length===100?page+1:null};
  }
  if(operation==='repository_release'){
   if(!Number.isSafeInteger(input.releaseId)||input.releaseId<=0)fail('release_invalid');return releaseView(await api(r.prefix+'/releases/'+input.releaseId));
  }
  if(!clean(requestId,200))fail('request_invalid');const id='act_'+digest(['owner',requestId]).slice(0,24);
  const existing=await store.get('action',id);if(existing&&(existing.operation!==operation||digest(existing.input)!==digest(input)))fail('request_conflict');if(existing?.output)return existing.output;
  let prepared=existing?.prepared;
  if(!prepared){
   if(operation==='repository_fastforward'){
    if(!ref(input.branch)||!commit(input.expectedCommit)||!commit(input.commit))fail('branch_invalid');
    await api(r.prefix+'/git/commits/'+input.commit);
    prepared={branch:input.branch,expectedCommit:input.expectedCommit,commit:input.commit};
   }else if(operation==='repository_release_prepare'){
    if(!ref(input.tag)||!commit(input.commit)||!clean(input.title,256)||!clean(input.body,16000)||typeof input.prerelease!=='boolean')fail('release_invalid');
    await api(r.prefix+'/git/commits/'+input.commit);
    const tag=await resolve(r,input.tag);if(tag&&tag!==input.commit)fail('tag_commit_changed');
    prepared={tag:input.tag,commit:input.commit,title:input.title,body:input.body+'\n\n<!-- Claus-Action: '+id+' -->',prerelease:input.prerelease};
   }else if(operation==='repository_release_publish'){
    if(!Number.isSafeInteger(input.releaseId)||input.releaseId<=0||!Number.isFinite(Date.parse(input.expectedUpdatedAt)))fail('release_invalid');
    const managed=await store.get('repository-release',r.id+':'+input.releaseId);if(!managed)fail('release_not_managed');
    const current=await api(r.prefix+'/releases/'+input.releaseId);
    if(current.updated_at!==input.expectedUpdatedAt||current.tag_name!==managed.tag||digest([current.name,current.body,current.prerelease])!==managed.contentHash)fail('release_changed');
    prepared={...managed,expectedUpdatedAt:input.expectedUpdatedAt};
   }else fail('operation_invalid');
   prepared=(await store.begin(id,operation,input,prepared)).row.result.prepared;
  }
  const complete=value=>store.complete(id,{id,resourceId:r.id,...value});
  if(operation==='repository_fastforward'){
   const path=r.prefix+'/git/ref/heads/'+encodeURIComponent(prepared.branch),current=await api(path);
   if(current.object.sha!==prepared.commit){
    if(current.object.sha!==prepared.expectedCommit)fail('branch_changed');
    const comparison=await api(r.prefix+'/compare/'+prepared.expectedCommit+'...'+prepared.commit);
    if(!['ahead','identical'].includes(comparison.status))fail('fastforward_required');
    await dispatch(id,()=>api(r.prefix+'/git/refs/heads/'+encodeURIComponent(prepared.branch),{method:'PATCH',body:{sha:prepared.commit,force:false}}));
   }
   const after=await api(path);if(after.object.sha!==prepared.commit)return {id,state:'outcome_unknown',retry:false};
   return complete({branch:prepared.branch,commit:prepared.commit,previousCommit:prepared.expectedCommit,historyPreserved:true});
  }
  if(operation==='repository_release_prepare'){
   const matches=v=>v.tag_name===prepared.tag&&v.target_commitish===prepared.commit&&v.name===prepared.title&&v.body===prepared.body&&v.prerelease===prepared.prerelease;
   let current=await byTag(r,prepared.tag);
   if(current&&!matches(current))fail('release_tag_in_use');
   if(!current)current=await dispatch(id,()=>api(r.prefix+'/releases',{method:'POST',body:{tag_name:prepared.tag,target_commitish:prepared.commit,name:prepared.title,body:prepared.body,prerelease:prepared.prerelease,draft:true,generate_release_notes:false}}));
   current??=await byTag(r,prepared.tag);
   if(!current)return {id,state:'outcome_unknown',retry:false};if(!matches(current))fail('release_changed');
   const binding={releaseId:current.id,tag:prepared.tag,commit:prepared.commit,contentHash:digest([current.name,current.body,current.prerelease]),sourceActionId:id};
   const saved=await store.put('repository-release',r.id+':'+current.id,binding);if(digest(saved.value)!==digest(binding))fail('release_binding_conflict');
   return complete({release:releaseView(current),sourceCommit:prepared.commit});
  }
  const path=r.prefix+'/releases/'+prepared.releaseId;let current=await api(path);
  if(current.tag_name!==prepared.tag||digest([current.name,current.body,current.prerelease])!==prepared.contentHash)fail('release_changed');
  const tag=await resolve(r,prepared.tag);if(tag&&tag!==prepared.commit)fail('tag_commit_changed');
  if(current.draft){
   if(current.updated_at!==prepared.expectedUpdatedAt)fail('release_changed');
   await dispatch(id,()=>api(path,{method:'PATCH',body:{draft:false,make_latest:'false'}}));current=await api(path);
  }
  if(current.draft)return {id,state:'outcome_unknown',retry:false};
  if(await resolve(r,prepared.tag)!==prepared.commit)fail('published_tag_mismatch');
  return complete({release:releaseView(current),sourceCommit:prepared.commit,published:true});
 }
 return {call:callRelease};
}
