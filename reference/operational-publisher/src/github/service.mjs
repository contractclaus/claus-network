import {createHash} from 'node:crypto';

const repositories=new Set(['contractclaus/claus-network','contractclaus/claus-network-contracts']);
const sha=/^[a-f0-9]{40}$/;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const author={name:'Claus',email:'341484431+contractclaus@users.noreply.github.com'};
const check=(condition,code)=>{if(!condition)throw Error('github_'+code);};
// The token stays in custody. Published source is fetched from the immutable
// public Network release, never from arbitrary model text or private files.
export function createGithub({token=()=>process.env.CLAUS_GITHUB_TOKEN,request=fetch,ledger}={}){
 async function api(path,{method='GET',body,missing=false}={}){
  check(token(),'not_configured');
  const response=await request('https://api.github.com'+path,{method,redirect:'error',signal:AbortSignal.timeout(25000),headers:{authorization:'Bearer '+token(),accept:'application/vnd.github+json','x-github-api-version':'2022-11-28','user-agent':'contractclaus',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  if(missing&&response.status===404)return null;
  check(response.ok,'provider_'+response.status);
  const text=await response.text();check(Buffer.byteLength(text)<=4000000,'response_size');return JSON.parse(text);
 }
 async function publicJson(path){const response=await request('https://claus-network-api.vercel.app'+path,{redirect:'error',signal:AbortSignal.timeout(20000)});check(response.ok,'release_unavailable');const text=await response.text();check(Buffer.byteLength(text)<=4000000,'source_size');return JSON.parse(text);}
 async function releaseFiles(id){
  check(/^sha256:[a-f0-9]{64}$/.test(id??''),'release_invalid');
  const release=await publicJson('/v1/public/releases/'+encodeURIComponent(id));
  const value=release.release??release;
  check(Array.isArray(value.paths)&&value.paths.length>0&&value.paths.length<=256,'release_invalid');
  check(typeof value.projectId==='string','release_project_missing');
  const prefix='projects/'+hash(value.projectId).slice(0,16)+'/';
  const files=[];let size=0;
  for(const path of value.paths){check(typeof path==='string'&&!path.startsWith('/')&&!path.split('/').some(x=>x==='..'||x==='.'),'source_path');
   const result=await publicJson('/v1/public/releases/'+encodeURIComponent(id)+'/file?filePath='+encodeURIComponent(path));
   const content=result.content??result.file?.content;check(typeof content==='string','source_encoding');size+=Buffer.byteLength(content);check(size<=3000000,'source_size');files.push({path:prefix+path,content});}
  return files;
 }
 async function recover(repository,branch){
  const ref=await api('/repos/'+repository+'/git/ref/heads/'+encodeURIComponent(branch),{missing:true});
  const pulls=await api('/repos/'+repository+'/pulls?state=all&head='+encodeURIComponent('contractclaus:'+branch));
  return {repository,branch,commit:ref?.object?.sha??null,pullRequest:pulls[0]?{number:pulls[0].number,url:pulls[0].html_url,state:pulls[0].state}:null,replayed:false};
 }
 return async function call(input){
  check(input&&typeof input==='object'&&!Array.isArray(input),'input_invalid');
  const {operation,repository='contractclaus/claus-network'}=input;
  check(repositories.has(repository),'repository_denied');
  if(operation==='status'){const user=await api('/user');check(user.login==='contractclaus','identity_mismatch');const details=[];for(const name of repositories){const repo=await api('/repos/'+name);check(repo.owner?.login==='contractclaus','identity_mismatch');const ref=await api('/repos/'+name+'/git/ref/heads/'+encodeURIComponent(repo.default_branch));details.push({repository:name,defaultBranch:repo.default_branch,headSha:ref.object?.sha});}return {identity:user.login,repositories:details,publication:'public-network-release-to-project-folder',author,merge:false};}
  if(operation==='tree'){check(sha.test(input.ref??''),'ref_required');const r=await api('/repos/'+repository+'/git/trees/'+input.ref+'?recursive=1');return {sha:r.sha,truncated:r.truncated,items:r.tree?.slice(0,3000).map(v=>({path:v.path,type:v.type,sha:v.sha,size:v.size}))};}
  if(operation==='file'){check(sha.test(input.ref??'')&&typeof input.path==='string'&&input.path.length<=240&&!input.path.split('/').some(x=>x==='..'),'file_invalid');const r=await api('/repos/'+repository+'/contents/'+input.path.split('/').map(encodeURIComponent).join('/')+'?ref='+input.ref);check(r.type==='file'&&r.encoding==='base64'&&r.size<=400000,'file_size');return {path:r.path,sha:r.sha,content:Buffer.from(r.content,'base64').toString('utf8')};}
  if(operation==='pulls'){const r=await api('/repos/'+repository+'/pulls?state=open&per_page=50');return {items:r.map(p=>({number:p.number,title:p.title,url:p.html_url,head:p.head.sha,base:p.base.sha}))};}
  check(operation==='publish'||operation==='recover','operation_invalid');
  check(typeof input.id==='string'&&/^[a-zA-Z0-9:_-]{1,160}$/.test(input.id),'id_required');
  const branch='claus/'+hash({id:input.id,repository}).slice(0,32),id='github:'+hash({id:input.id,repository});
  if(operation==='recover')return recover(repository,branch);
  check(sha.test(input.baseSha??'')&&/^sha256:[a-f0-9]{64}$/.test(input.releaseId??''),'source_required');
  check(typeof input.title==='string'&&input.title.length>0&&input.title.length<=180&&typeof input.body==='string'&&input.body.length<=4000,'description_invalid');
  const binding={repository,baseSha:input.baseSha,releaseId:input.releaseId,title:input.title,body:input.body};
  const saved=await ledger.reserve(id,binding);
  if(!saved.created)return saved.row.status==='completed'?saved.row.result:{state:'unknown',...await recover(repository,branch),next:'recover'};
  const account=await api('/user');check(account.login==='contractclaus','identity_mismatch');
  const repo=await api('/repos/'+repository);check(repo.owner?.login==='contractclaus','identity_mismatch');
  const base=await api('/repos/'+repository+'/git/commits/'+input.baseSha);
  const files=await releaseFiles(input.releaseId),tree=[];
  for(const file of files){const blob=await api('/repos/'+repository+'/git/blobs',{method:'POST',body:{content:file.content,encoding:'utf-8'}});tree.push({path:file.path,mode:'100644',type:'blob',sha:blob.sha});}
  const built=await api('/repos/'+repository+'/git/trees',{method:'POST',body:{base_tree:base.tree.sha,tree}});
  const commit=await api('/repos/'+repository+'/git/commits',{method:'POST',body:{message:'Publish Network project\n\nNetwork source: '+input.releaseId,tree:built.sha,parents:[input.baseSha],author,committer:author}});
  await api('/repos/'+repository+'/git/refs',{method:'POST',body:{ref:'refs/heads/'+branch,sha:commit.sha}});
  const pull=await api('/repos/'+repository+'/pulls',{method:'POST',body:{title:input.title,body:input.body,head:branch,base:repo.default_branch,draft:true}});
  const result={state:'completed',repository,branch,commit:commit.sha,releaseId:input.releaseId,pullRequest:{number:pull.number,url:pull.html_url,state:pull.state},author,merged:false};
  await ledger.complete(id,result);return result;
 };
}
