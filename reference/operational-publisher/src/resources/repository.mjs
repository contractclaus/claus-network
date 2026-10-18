import {createHash} from 'node:crypto';
export const repositoryIdentity={name:'Claus',email:'341484431+contractclaus@users.noreply.github.com'};
const error=c=>{throw Error('resource_repository_'+c);};
const validPath=p=>typeof p==='string'&&p.length>0&&p.length<=240&&!p.startsWith('/')&&!p.includes('\\')&&p.split('/').every(x=>x&&x!=='.'&&x!=='..'&&x!=='.git')&&!/(^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.netrc$|id_rsa$|id_ed25519$)/.test(p);
const ref=v=>{if(typeof v!=='string'||v.length>180||! /^[A-Za-z0-9_./-]+$/.test(v)||v.includes('..')||v.includes('//')||v.endsWith('/')||v.endsWith('.lock')||v.startsWith('/'))error('ref_invalid');return v;};
const commit=v=>{if(!/^[a-f0-9]{40}$/.test(v??''))error('commit_invalid');return v;};
const blobSha=bytes=>createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
export function managedRepository({call,request=fetch,token=()=>process.env.CLAUS_GITHUB_TOKEN}){
 const prefix=r=>{if(r.provider!=='github'||r.owner!=='contractclaus'||!/^claus-[a-z0-9-]+$/.test(r.name))error('scope_invalid');return '/repos/contractclaus/'+r.name;};
 const path=p=>{if(!validPath(p))error('path_invalid');return p.split('/').map(encodeURIComponent).join('/');};
 const github=(p,o)=>call('github',p,o);
 return {
  async repositoryFile(r,input){
   const offset=input.offset??0;if(!Number.isSafeInteger(offset)||offset<0)error('offset_invalid');
   const result=await github(prefix(r)+'/contents/'+path(input.path)+(input.ref?'?ref='+encodeURIComponent(ref(input.ref)):''),{missing:true});
   if(!result)return {exists:false,path:input.path};
   if(Array.isArray(result))return {kind:'directory',entries:result.map(x=>({name:x.name,path:x.path,type:x.type,sha:x.sha,bytes:x.size}))};
   if(result.type!=='file'||result.encoding!=='base64')error('use_object_transfer');
   const bytes=Buffer.from(result.content.replace(/\n/g,''),'base64');if(blobSha(bytes)!==result.sha)error('integrity_failed');
   const selected=bytes.subarray(offset,offset+48000);return {kind:'file',path:result.path,blobSha:result.sha,bytes:bytes.length,encoding:'base64',content:selected.toString('base64'),offset,nextOffset:offset+selected.length<bytes.length?offset+selected.length:null};
  },
  async repositoryWrite(r,input,actionId,dispatch){
   const p=prefix(r)+'/contents/'+path(input.path),branch=ref(input.branch??r.defaultBranch??'main');
   if(typeof input.content!=='string'||!['utf8','base64'].includes(input.encoding??'utf8'))error('content_invalid');
   const bytes=Buffer.from(input.content,input.encoding==='base64'?'base64':'utf8');if(bytes.length>2*1024*1024)error('inline_file_too_large');
   if(input.encoding==='base64'&&bytes.toString('base64')!==input.content)error('content_invalid');
   if(input.expectedBlobSha!==null&&!/^[a-f0-9]{40}$/.test(input.expectedBlobSha??''))error('expected_blob_required');
   const wanted=blobSha(bytes);let current=await github(p+'?ref='+encodeURIComponent(branch),{missing:true});
   if(current?.sha!==wanted){
    if((current?.sha??null)!==input.expectedBlobSha)error('file_changed');
    if(await dispatch())await github(p,{method:'PUT',body:{message:(input.message?.slice(0,200)||'Update owned application source')+'\n\nClaus-Action: '+actionId,content:bytes.toString('base64'),branch,...(current?.sha?{sha:current.sha}:{}),author:repositoryIdentity,committer:repositoryIdentity}});
    current=await github(p+'?ref='+encodeURIComponent(branch),{missing:true});
   }
   if(current?.sha!==wanted)return {state:'outcome_unknown',retry:false};
   const head=await github(prefix(r)+'/git/ref/heads/'+encodeURIComponent(branch));return {resourceId:r.id,path:input.path,blobSha:wanted,commit:head.object.sha,branch,state:'written'};
  },
  async repositoryBranch(r,input,dispatch){
   const name=ref(input.branch),sha=commit(input.commit),p=prefix(r);await github(p+'/git/commits/'+sha);
   let current=await github(p+'/git/ref/heads/'+encodeURIComponent(name),{missing:true});
   if(!current&&await dispatch())await github(p+'/git/refs',{method:'POST',body:{ref:'refs/heads/'+name,sha}});
   current=await github(p+'/git/ref/heads/'+encodeURIComponent(name),{missing:true});
   if(!current)return {state:'outcome_unknown',retry:false};if(current.object.sha!==sha)error('branch_changed');return {resourceId:r.id,branch:name,commit:sha};
  },
  async repositoryTree(r,sha){
   commit(sha);const p=prefix(r),c=await github(p+'/git/commits/'+sha),tree=await github(p+'/git/trees/'+c.tree.sha+'?recursive=1');
   if(tree.truncated)error('tree_truncated');
   const files=tree.tree.filter(x=>x.type!=='tree').map(x=>{if(x.type!=='blob'||!['100644','100755'].includes(x.mode)||!validPath(x.path)||!Number.isSafeInteger(x.size)||x.size<0||x.size>100*1024*1024)error('source_requires_preparation');return {path:x.path,gitSha:x.sha,size:x.size};});
   return {commit:sha,tree:c.tree.sha,files};
  },
  async repositoryBlob(r,file){
   commit(file.gitSha);const response=await request('https://api.github.com'+prefix(r)+'/git/blobs/'+file.gitSha,{headers:{authorization:'Bearer '+token(),accept:'application/vnd.github.raw+json'},redirect:'error',signal:AbortSignal.timeout(60000)});
   if(!response.ok)error('blob_'+response.status);const chunks=[];let length=0;
   for await(const chunk of response.body){length+=chunk.length;if(length>file.size)error('blob_size');chunks.push(chunk);}
   const bytes=Buffer.concat(chunks);if(length!==file.size||blobSha(bytes)!==file.gitSha)error('integrity_failed');return bytes;
  }
 };
}
