import {canonical,digest,PROGRAM_REPOSITORY} from './evidence.js';
const repository='contractclaus/claus-network-contracts';
const author={name:'Claus',email:'341484431+contractclaus@users.noreply.github.com'};
export function programSource(files){
 if(!Array.isArray(files)||files.length<1||files.length>64)throw Error('program_invalid_source');
 const normalized=files.map(f=>{
  if(!f||Object.keys(f).sort().join(',')!=='content,path'||typeof f.content!=='string'||!f.content.length||typeof f.path!=='string'||f.path.length>180||!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.sol$/.test(f.path)||Buffer.byteLength(f.content)>100000)throw Error('program_invalid_source');
  return {path:f.path,content:f.content};
 }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 if(new Set(normalized.map(f=>f.path)).size!==normalized.length||Buffer.byteLength(canonical(normalized))>320000)throw Error('program_invalid_source');
 return {files:normalized,sourceHash:digest(normalized)};
}
export function createProgramSourcePublisher({repositoryStore,token=()=>process.env.PROGRAM_GITHUB_TOKEN,request=fetch,clock=()=>new Date().toISOString()}){
 async function api(path,method='GET',body){
  const secret=token();if(!secret)throw Error('program_source_publisher_unavailable');
  const r=await request('https://api.github.com'+path,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+secret,accept:'application/vnd.github+json','content-type':'application/json','x-github-api-version':'2022-11-28'},...(body?{body:JSON.stringify(body)}:{})});
  if(!r.ok){await r.body?.cancel();throw Object.assign(Error('program_source_provider_error'),{status:r.status});}
  const bodyText=await r.text();if(Buffer.byteLength(bodyText)>4000000)throw Error('program_source_response_too_large');return JSON.parse(bodyText);
 }
 async function inspect(ref,files){
  const found=await api('/repos/'+repository+'/git/ref/heads/'+ref);
  const commit=await api('/repos/'+repository+'/git/commits/'+found.object.sha);
  if(commit.author?.name!==author.name||commit.author.email!==author.email||commit.committer?.name!==author.name||commit.committer.email!==author.email)throw Error('program_source_author_mismatch');
  const tree=await api('/repos/'+repository+'/git/trees/'+commit.tree.sha+'?recursive=1');
  const expected=files.map(f=>({path:f.path,mode:'100644',type:'blob',sha:createBlobHash(f.content)}));
  const actual=tree.tree?.filter(n=>n.type==='blob').map(({path,mode,type,sha})=>({path,mode,type,sha})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  if(tree.truncated||canonical(actual)!==canonical(expected))throw Error('program_source_tree_mismatch');
  return {repository:PROGRAM_REPOSITORY,commit:commit.sha,branch:ref,sourceHash:digest(files),files:files.map(f=>f.path)};
 }
 return {async publish(input){
  if(!input||Object.keys(input).join(',')!=='files')throw Error('program_invalid_source');
  const {files,sourceHash}=programSource(input.files),ref='native-program-'+sourceHash.slice(7),id='program-source:'+sourceHash.slice(7);
  let intent=await repositoryStore.release(id);
  if(!intent){const next={sourceHash,createdAt:clock()};try{await repositoryStore.attest(id,next);}catch(e){if(e.message!=='release_id_conflict')throw e;}intent=await repositoryStore.release(id);}
  if(intent.sourceHash!==sourceHash)throw Error('program_source_intent_mismatch');
  try{return await inspect(ref,files);}catch(e){if(e.status!==404)throw e;}
  const user=await api('/user');if(user.login!=='contractclaus')throw Error('program_source_account_mismatch');
  const tree=await api('/repos/'+repository+'/git/trees','POST',{tree:files.map(f=>({path:f.path,mode:'100644',type:'blob',content:f.content}))});
  const commit=await api('/repos/'+repository+'/git/commits','POST',{message:'Claus trade program '+sourceHash,tree:tree.sha,parents:[],author:{...author,date:intent.createdAt},committer:{...author,date:intent.createdAt}});
  try{await api('/repos/'+repository+'/git/refs','POST',{ref:'refs/heads/'+ref,sha:commit.sha});}catch(e){if(e.status!==422)throw e;}
  // Unknown writes only retry deterministic git objects/ref. Never advance main,
  // replace a branch, upload executable workflows, or choose an external repo.
  return inspect(ref,files);
 }};
}
import {createHash} from 'node:crypto';
function createBlobHash(text){const b=Buffer.from(text);return createHash('sha1').update(Buffer.from('blob '+b.length+'\0')).update(b).digest('hex');}
