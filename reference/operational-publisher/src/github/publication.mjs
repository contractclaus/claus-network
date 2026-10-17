import {createHash} from 'node:crypto';
import {hash,sha,patch,validateChanges,validateManifest} from '../publisher/policy.js';
import {trustedReview} from '../publisher/review-evidence.js';
import {publicationControls} from '../publisher/controls.js';
const repo='contractclaus/claus-network';
const author={name:'Claus',email:'341484431+contractclaus@users.noreply.github.com'};
const fail=code=>{throw Error('publisher_'+code);};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const git=id=>{if(!/^git_[a-f0-9]{40}$/.test(id??''))fail('commit_invalid');return id.slice(4);};
const permitted=p=>p==='README.md'||/^docs\/[a-z0-9-]+\.md$/.test(p);
export function createRepositoryPublisher({repository,ledger,controls,reviewEvidence=trustedReview,request=fetch,token=()=>process.env.CLAUS_GITHUB_TOKEN}){
 const control=()=>controls??=publicationControls();
 async function api(path,{method='GET',body,missing=false}={}){
  if(!token())fail('github_unavailable');
  const response=await request('https://api.github.com'+path,{method,redirect:'error',signal:AbortSignal.timeout(25000),headers:{authorization:'Bearer '+token(),accept:'application/vnd.github+json','x-github-api-version':'2022-11-28','user-agent':'contractclaus',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  if(missing&&response.status===404)return null;
  if(!response.ok)fail('github_request_failed');const text=await response.text();if(Buffer.byteLength(text)>4000000)fail('source_size');return JSON.parse(text);
 }
 async function head(){const r=await api('/repos/'+repo);if(r.owner?.login!=='contractclaus')fail('github_identity');const ref=await api('/repos/'+repo+'/git/ref/heads/'+encodeURIComponent(r.default_branch));return{branch:r.default_branch,commit:ref.object.sha};}
 async function file(id,path){git(id);if(!permitted(path))fail('file_denied');const r=await api('/repos/'+repo+'/contents/'+path+'?ref='+git(id));if(r.type!=='file'||r.encoding!=='base64'||r.size>400000)fail('file_invalid');return Buffer.from(r.content,'base64').toString('utf8');}
 async function verify(id,manifest,production=false){validateManifest(manifest);if(manifest.some(f=>!permitted(f.path)))fail('file_denied');if(production&&(await head()).commit!==git(id))fail('production_changed');await Promise.all(manifest.map(async ref=>{const value=await file(id,ref.path);if(sha(value)!==ref.sha||Buffer.byteLength(value)!==ref.size)fail('source_binding');}));return {passed:true,sourceHash:hash(manifest),commit:git(id),production};}
 async function current(){const c=await repository.current('repository');if(!c)fail('scope_missing');return c;}
 async function release(id){if(!/^op_[a-f0-9]{24}$/.test(id??''))fail('release_invalid');const r=await repository.release(id);if(r?.scope!=='repository')fail('release_missing');return r;}
 async function reviewed(r,c){
  if(!c.enabled||c.revision!==r.base_revision||c.deployment!==r.base_deployment||!(await repository.settings()).enabled)fail('base_changed');
  validateChanges('repository',r.changes);validateManifest(r.manifest);const expected=structuredClone(c.manifest);
  if(r.files.length!==r.changes.length||new Set(r.files.map(f=>f.path)).size!==r.files.length)fail('files_invalid');
  for(const change of r.changes){const f=r.files.find(f=>f.path===change.path),ref=expected.find(f=>f.path===change.path);if(!f||!ref||sha(f.before)!==ref.sha||Buffer.byteLength(f.before)!==ref.size||patch(f.before,change)!==f.content)fail('source_binding');ref.sha=sha(f.content);ref.size=Buffer.byteLength(f.content);}
  if(!equal(expected,r.manifest)||hash(expected)!==r.source_hash)fail('manifest_binding');
  const effect=await repository.review(r.review_effect);if(!effect||effect.project_id!==r.build_id||effect.status!=='completed'||effect.kind!=='model')fail('review_incomplete');const output=await reviewEvidence(effect,'operational');
  let input,result;try{input=JSON.parse(effect.input.input[0].content);const value=output.message.content;result=JSON.parse((Array.isArray(value)?value.map(x=>x.text??'').join(''):String(value)).replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{fail('review_invalid');}
  if(input.scope!=='repository'||input.sourceHash!==r.source_hash||input.baseDeployment!==r.base_deployment||!equal(input.changes,r.changes)||!equal(input.files,r.files))fail('review_binding');
  if(result.approved!==true||result.withinScope!==true||result.preservesBehaviour!==true)fail('review_rejected');
 }
 const branch=r=>'claus/docs-'+r.id;
 async function recover(r){const ref=await api('/repos/'+repo+'/git/ref/heads/'+branch(r),{missing:true});if(!ref)return null;const commit=await api('/repos/'+repo+'/git/commits/'+ref.object.sha);if(commit.parents?.length!==1||commit.parents[0].sha!==git(r.base_deployment)||commit.author.email!==author.email||commit.committer.email!==author.email||commit.message!=='Update documentation: '+r.title+'\n\nOperation: '+r.id+'\nSource: '+r.source_hash)fail('commit_binding');const delta=await api('/repos/'+repo+'/compare/'+git(r.base_deployment)+'...'+commit.sha);if(delta.commits?.length!==1||delta.files?.length!==r.files.length||delta.files.some(f=>!r.files.some(w=>w.path===f.filename)||!['modified'].includes(f.status)))fail('commit_files_mismatch');await verify('git_'+commit.sha,r.manifest);return{id:'git_'+commit.sha,url:'github.com/'+repo+'/commit/'+commit.sha,state:'READY',readyState:'READY',projectId:repo,meta:{clausOperationId:r.id,clausSourceHash:r.source_hash}};}
 async function deploy(r,c){
  await reviewed(r,c);if((await head()).commit!==git(c.deployment))fail('base_changed');
  const key='repository:deploy:'+r.id,saved=await ledger.reserve(key,{base:r.base_deployment,hash:r.source_hash});
  const existing=await recover(r);if(existing){await ledger.complete(key,existing);return existing;}
  if(!saved.created)fail('outcome_unknown');
  // Blobs and commits are content-addressed. The branch is the single publication intent.
  const base=await api('/repos/'+repo+'/git/commits/'+git(r.base_deployment)),tree=[];
  for(const f of r.files){const blob=await api('/repos/'+repo+'/git/blobs',{method:'POST',body:{content:f.content,encoding:'utf-8'}});tree.push({path:f.path,mode:'100644',type:'blob',sha:blob.sha});}
  const built=await api('/repos/'+repo+'/git/trees',{method:'POST',body:{base_tree:base.tree.sha,tree}});
  const identity={...author,date:new Date(r.created_at).toISOString()};const commit=await api('/repos/'+repo+'/git/commits',{method:'POST',body:{message:'Update documentation: '+r.title+'\n\nOperation: '+r.id+'\nSource: '+r.source_hash,tree:built.sha,parents:[git(r.base_deployment)],author:identity,committer:identity}});
  await verify('git_'+commit.sha,r.manifest);await api('/repos/'+repo+'/git/refs',{method:'POST',body:{ref:'refs/heads/'+branch(r),sha:commit.sha}});
  const value=await recover(r);await ledger.complete(key,value);return value;
 }
 return {async call(operation,scope,args){
  if(scope!=='repository'||!Array.isArray(args))fail('operation_denied');const c=await current();
  if(operation==='project'){const h=await head();return{id:repo,name:'claus-network',targets:{production:{id:'git_'+h.commit}},crons:{definitions:[]}};}
  if(operation==='baseline'){if(args[0]!==c.deployment||!equal(args[1],c.manifest))fail('base_changed');return verify(c.deployment,c.manifest,true);}
  if(operation==='read'){const[id,ref]=args;if(id!==c.deployment||!c.manifest.some(f=>equal(f,ref)))fail('file_denied');const value=await file(id,ref.path);if(sha(value)!==ref.sha)fail('source_binding');return value;}
  if(operation==='deployment'){const id=args[0];if(id!==c.deployment&&!await repository.byDeployment(scope,id))fail('commit_binding');return{id,url:'github.com/'+repo+'/commit/'+git(id),state:'READY',projectId:repo};}
  if(operation==='deploy'){const[base,manifest,files,id,sourceHash]=args,r=await release(id);if(!r.deploy_started||!['review_pending','deploying'].includes(r.state)||base!==r.base_deployment||sourceHash!==r.source_hash||!equal(manifest,r.manifest)||!equal(files,r.files))fail('release_binding');return deploy(r,c);}
  if(operation==='reconcile'){const[id,sourceHash,known]=args,r=await release(id);if(sourceHash!==r.source_hash||known&&known!==r.deployment?.id)fail('release_binding');return recover(r);}
  if(operation==='verify'){const[d,manifest,production]=args;const r=await repository.byDeployment(scope,d.id);if(typeof production!=='boolean'||!(d.id===c.deployment&&equal(manifest,c.manifest)||r&&d.id===r.deployment?.id&&equal(manifest,r.manifest)))fail('manifest_binding');return verify(d.id,manifest,production);}
  if(operation==='restored'){git(args[0]);return(await head()).commit===git(args[0]);}
  if(operation==='promote'){
   const[base,d]=args,r=await repository.promotion(scope,base,d.id);if(!r||base!==r.base_deployment||d.id!==r.deployment?.id||!r.promote_started)fail('promotion_unbound');await reviewed(r,c);const deployed=await recover(r);if(deployed?.id!==d.id)fail('commit_binding');const h=await head();if(h.commit===git(d.id))return{promoted:true,id:d.id};if(h.commit!==git(base))fail('base_changed');
   const key='repository:promote:'+r.id,old=await ledger.reserve(key,{base,target:d.id});if(!old.created)fail('outcome_unknown');
   const pulls=await api('/repos/'+repo+'/pulls?state=all&head='+encodeURIComponent('contractclaus:'+branch(r)));let pull=pulls[0];
   if(!pull)pull=await api('/repos/'+repo+'/pulls',{method:'POST',body:{title:r.title,body:'Reviewed documentation update.\n\nOperation: `'+r.id+'`\nSource: `'+r.source_hash+'`',head:branch(r),base:h.branch,draft:false}});
   if(pull.head.sha!==git(d.id)||pull.base.ref!==h.branch)fail('pull_binding');
   // Fast-forward only, with Claus as sole author/committer. No force-push or generic merge capability.
   await api('/repos/'+repo+'/git/refs/heads/'+encodeURIComponent(h.branch),{method:'PATCH',body:{sha:git(d.id),force:false}});
   await verify(d.id,r.manifest,true);const result={promoted:true,id:d.id,pullRequest:pull.html_url};await ledger.complete(key,result);return result;
  }
  if(operation==='activate'){
   const r=await release(args[0]),old=await control().activated('operation',r.id);if(old&&old.deployment===c.deployment&&old.revision===c.revision)return old;
   await reviewed(r,c);if(r.state!=='verified'||!r.promote_started)fail('publication_not_proven');const saved=await ledger.get('repository:promote:'+r.id);if(!saved||saved.input_hash!==hash({base:r.base_deployment,target:r.deployment?.id}))fail('publication_not_proven');const proof=await verify(r.deployment.id,r.manifest,true);return control().activateOperation(c,r,{...proof,sourceHash:r.source_hash,reviewEffect:r.review_effect,pullRequest:saved.result?.pullRequest??null,verifiedBy:'fixed-repository-publisher'});
  }
  fail('operation_denied');
 }};
}
