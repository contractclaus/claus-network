import {createHash} from 'node:crypto';
import {digest,sameValue} from './store.mjs';
import {repositoryIdentity} from './repository.mjs';
const fail=c=>{throw Error('resource_merge_'+c);};
const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const validPath=s=>typeof s==='string'&&s.length>0&&s.length<=500&&!/[\x00-\x1f\\]/.test(s)&&s.split('/').every(x=>x&&x!=='.'&&x!=='..'&&x!=='.git');
const protectedPath=s=>s.startsWith('.github/workflows/')||/(^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.netrc$|id_rsa$|id_ed25519$)/.test(s);
const same=(a,b)=>(a?.sha??null)===(b?.sha??null)&&(a?.mode??null)===(b?.mode??null);
const objectHash=(type,bytes)=>createHash('sha1').update(Buffer.from(type+' '+bytes.length+'\0')).update(bytes).digest('hex');
export function gitTreeHash(files){
 const root=new Map();
 for(const f of files){if(!validPath(f.path)||!sha(f.sha)||!['100644','100755'].includes(f.mode))fail('file_invalid');const bits=f.path.split('/');let node=root;
  for(let i=0;i<bits.length-1;i++){if(node.has(bits[i])&&!(node.get(bits[i]) instanceof Map))fail('directory_conflict');if(!node.has(bits[i]))node.set(bits[i],new Map());node=node.get(bits[i]);}
  const name=bits.at(-1);if(node.has(name))fail('directory_conflict');node.set(name,f);
 }
 function hash(node){const items=[...node].map(([name,value])=>value instanceof Map?{name,mode:'40000',sha:hash(value),sort:name+'/'}:{name,mode:value.mode,sha:value.sha,sort:name}).sort((a,b)=>Buffer.compare(Buffer.from(a.sort),Buffer.from(b.sort)));
  return objectHash('tree',Buffer.concat(items.flatMap(x=>[Buffer.from(x.mode+' '+x.name+'\0'),Buffer.from(x.sha,'hex')])));
 }return hash(root);
}
export function gitCommitObject(tree,parents,message,date){
 const seconds=Math.floor(Date.parse(date)/1000);if(!sha(tree)||!parents.every(sha)||!Number.isSafeInteger(seconds)||message.includes('\r')||!message.endsWith('\n'))fail('commit_invalid');
 const identity=repositoryIdentity.name+' <'+repositoryIdentity.email+'> '+seconds+' +0000';
 const content='tree '+tree+'\n'+parents.map(x=>'parent '+x+'\n').join('')+'author '+identity+'\ncommitter '+identity+'\n\n'+message;
 return {sha:objectHash('commit',Buffer.from(content)),body:{tree,parents,message,author:{...repositoryIdentity,date},committer:{...repositoryIdentity,date}}};
}
export function mergeTrees(ancestor,base,head){
 const a=new Map(ancestor.map(f=>[f.path,f])),b=new Map(base.map(f=>[f.path,f])),h=new Map(head.map(f=>[f.path,f])),files=[],conflicts=[];
 for(const path of [...new Set([...a.keys(),...b.keys(),...h.keys()])].sort()){
  const av=a.get(path),bv=b.get(path),hv=h.get(path);let selected;
  if(same(bv,hv))selected=bv;else if(same(av,bv))selected=hv;else if(same(av,hv))selected=bv;else{conflicts.push({path,ancestor:av??null,base:bv??null,head:hv??null});continue;}
  if(selected)files.push(selected);
 }
 // File/directory collisions need explicit choices for both paths as well.
 const candidates=[...new Set([...files.map(x=>x.path),...conflicts.map(x=>x.path)])].sort(),structural=new Set();
 const possible=new Set(candidates);for(const path of candidates){const parts=path.split('/');for(let i=1;i<parts.length;i++){const prefix=parts.slice(0,i).join('/');if(possible.has(prefix)){structural.add(prefix);structural.add(path);}}}
 for(const path of structural)if(!conflicts.some(x=>x.path===path))conflicts.push({path,ancestor:a.get(path)??null,base:b.get(path)??null,head:h.get(path)??null,structural:true});
 return {files:files.filter(x=>!structural.has(x.path)),conflicts:conflicts.sort((a,b)=>a.path.localeCompare(b.path))};
}
export const mergeInputs={repository_merge_plan:['resourceId','branch','expectedBaseCommit','headCommit'],repository_merge_read:['resourceId','planId','offset'],repository_merge_apply:['resourceId','planId','resolutions','assessment']};
export function managedRepositoryMerge({store,call,now=Date.now}){
 const api=(path,options)=>call('github',path,options);
 async function repository(id){const r=await store.get('resource',id);if(!r||r.protected||r.provider!=='github'||r.owner!=='contractclaus'||!/^claus-[a-z0-9-]+$/.test(r.name)||r.retirementPlanId||['retired','archived','removed'].includes(r.status))fail('scope_invalid');const prefix='/repos/contractclaus/'+r.name,v=await api(prefix);if(String(v.id)!==r.providerId||v.owner?.login!=='contractclaus'||v.archived)fail('repository_changed');return {...r,prefix};}
 async function files(r,commit){const c=await api(r.prefix+'/git/commits/'+commit),t=await api(r.prefix+'/git/trees/'+c.tree.sha+'?recursive=1');if(t.truncated||!Array.isArray(t.tree))fail('tree_incomplete');const result=t.tree.filter(x=>x.type!=='tree').map(x=>{if(x.type!=='blob'||!['100644','100755'].includes(x.mode)||!validPath(x.path)||!sha(x.sha))fail('unsupported_tree_entry');return {path:x.path,mode:x.mode,sha:x.sha};});if(result.length>20000)fail('tree_too_large');if(gitTreeHash(result)!==c.tree.sha)fail('tree_integrity');return result;}
 async function plan(id,resourceId){const p=await store.get('repository-merge',id);if(!p||p.resourceId!==resourceId)fail('plan_missing');return p;}
 function summary(p,offset=0){const entries=[...p.merge.conflicts.map(x=>({...x,state:'conflict'})),...p.changes.map(x=>({...x,state:'change'}))];if(!Number.isSafeInteger(offset)||offset<0||offset>entries.length)fail('offset_invalid');return {planId:p.id,resourceId:p.resourceId,branch:p.branch,base:p.base,head:p.head,ancestor:p.ancestor,conflicts:p.merge.conflicts.length,changes:p.changes.length,entries:entries.slice(offset,offset+100),nextOffset:offset+100<entries.length?offset+100:null,applied:false,alreadyIncluded:p.ancestor===p.head,semanticReviewRequired:true};}
 async function ensureObject(r,type,expected,body){let v=await api(r.prefix+'/git/'+type+'/'+expected,{missing:true});if(v){if(v.sha!==expected)fail('object_integrity');return;}
  // Content-addressed object creation with an exact frozen payload. Repeating
  // it cannot create a second object; no branch moves during this step.
  try{v=await api(r.prefix+'/git/'+type,{method:'POST',body});}catch(error){v=await api(r.prefix+'/git/'+type+'/'+expected,{missing:true});if(!v)throw error;}
  if(v.sha!==expected)fail('object_integrity');
 }
 return {async call(operation,input,requestId){
  const r=await repository(input.resourceId);
  if(operation==='repository_merge_read')return summary(await plan(input.planId,r.id),input.offset??0);
  if(typeof requestId!=='string'||!requestId||requestId.length>200)fail('request_invalid');
  if(operation==='repository_merge_plan'){
   if(!sha(input.expectedBaseCommit)||!sha(input.headCommit)||! /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,179}$/.test(input.branch??'')||input.branch.includes('..')||input.branch.includes('//')||input.branch.endsWith('/')||input.branch.endsWith('.lock'))fail('definition_invalid');
   const id='mr_'+digest(requestId).slice(0,24),old=await store.get('repository-merge',id);if(old){if(!sameValue(old.input,input))fail('request_conflict');return summary(old);}
   const current=await api(r.prefix+'/git/ref/heads/'+encodeURIComponent(input.branch));if(current.object?.sha!==input.expectedBaseCommit)fail('base_changed');
   const comparison=await api(r.prefix+'/compare/'+input.expectedBaseCommit+'...'+input.headCommit),ancestor=comparison.merge_base_commit?.sha;if(!sha(ancestor))fail('common_ancestor_missing');
   const [a,b,h]=await Promise.all([files(r,ancestor),files(r,input.expectedBaseCommit),files(r,input.headCommit)]),merge=mergeTrees(a,b,h),baseMap=new Map(b.map(x=>[x.path,x])),mergedMap=new Map(merge.files.map(x=>[x.path,x])),conflictPaths=new Set(merge.conflicts.map(x=>x.path));
   const changes=[...new Set([...baseMap.keys(),...mergedMap.keys()])].filter(path=>!conflictPaths.has(path)&&!same(baseMap.get(path),mergedMap.get(path))).map(path=>({path,base:baseMap.get(path)??null,head:mergedMap.get(path)??null,protected:protectedPath(path)}));
   const p={id,resourceId:r.id,input,branch:input.branch,base:input.expectedBaseCommit,head:input.headCommit,ancestor,baseFiles:b,merge,changes,createdAt:new Date(now()).toISOString()};const saved=(await store.put('repository-merge',id,p)).value;if(!sameValue(saved.input,input))fail('request_conflict');return summary(saved);
  }
  if(operation!=='repository_merge_apply')fail('operation_invalid');
  const id='act_'+digest(['owner',requestId]).slice(0,24),old=await store.get('action',id);if(old&&(old.operation!==operation||!sameValue(old.input,input)))fail('request_conflict');if(old?.output)return old.output;
  const p=await plan(input.planId,r.id);if(p.ancestor===p.head)return {planId:p.id,resourceId:r.id,state:'already_integrated',commit:p.base,branch:p.branch,branchChanged:false};let prepared=old?.prepared;
  if(!prepared){
   if(!Array.isArray(input.resolutions)||input.resolutions.length!==p.merge.conflicts.length||typeof input.assessment!=='string'||!input.assessment.trim()||input.assessment.length>4000)fail('resolution_required');
   const resolutions=new Map(input.resolutions.map(x=>[x.path,x]));if(resolutions.size!==input.resolutions.length)fail('duplicate_resolution');const merged=[...p.merge.files],blobs=[];
   for(const c of p.merge.conflicts){const v=resolutions.get(c.path);if(!v||Object.keys(v).some(k=>!['path','choice','content','encoding','mode'].includes(k)))fail('resolution_invalid');let selected;
    if(['base','head'].includes(v.choice))selected=c[v.choice];else if(v.choice==='remove')selected=null;
    else if(v.choice==='content'){
     if(typeof v.content!=='string'||!['utf8','base64'].includes(v.encoding)||!['100644','100755'].includes(v.mode))fail('resolution_invalid');const bytes=Buffer.from(v.content,v.encoding);if(bytes.length>1000000||v.encoding==='base64'&&bytes.toString('base64')!==v.content)fail('resolution_size');const hash=objectHash('blob',bytes);blobs.push({sha:hash,body:{content:bytes.toString('base64'),encoding:'base64'}});selected={path:c.path,mode:v.mode,sha:hash};
    }else fail('resolution_invalid');if(selected)merged.push(selected);
   }
   const base=new Map(p.baseFiles.map(x=>[x.path,x])),result=new Map(merged.map(x=>[x.path,x]));for(const path of new Set([...base.keys(),...result.keys()]))if(protectedPath(path)&&!same(base.get(path),result.get(path)))fail('protected_path_use_managed_workflow');
   const tree=gitTreeHash(merged),date=new Date(Math.floor(now()/1000)*1000).toISOString(),message='Merge owned worker results\n\n'+input.assessment.trim().replaceAll('\r','')+'\n\nClaus-Action: '+id+'\n',commit=gitCommitObject(tree,[p.base,p.head],message,date);
   prepared={resourceId:r.id,planId:p.id,branch:p.branch,expectedBase:p.base,head:p.head,tree,treeBody:{tree:merged.map(x=>({...x,type:'blob'}))},blobs,commit};
   prepared=(await store.begin(id,operation,input,prepared)).row.result.prepared;
  }
  const refPath=r.prefix+'/git/ref/heads/'+encodeURIComponent(prepared.branch),current=await api(refPath);let merged=false;
  if(current.object.sha===prepared.commit.sha)merged=true;
  else if(current.object.sha!==prepared.expectedBase){const comparison=await api(r.prefix+'/compare/'+prepared.commit.sha+'...'+current.object.sha,{missing:true});if(comparison&&['ahead','identical'].includes(comparison.status))merged=true;else fail('base_changed');}
  if(!merged){
   for(const b of prepared.blobs)await ensureObject(r,'blobs',b.sha,b.body);
   await ensureObject(r,'trees',prepared.tree,prepared.treeBody);await ensureObject(r,'commits',prepared.commit.sha,prepared.commit.body);
   // The branch move remains one original action. Unknown PATCH outcomes are
   // observed by the expected commit, never force-pushed or blindly resent.
   if(await store.dispatch(id))try{await api(r.prefix+'/git/refs/heads/'+encodeURIComponent(prepared.branch),{method:'PATCH',body:{sha:prepared.commit.sha,force:false}});}catch(e){if(e.status===429){e.retryAt=Math.max(now()+1000,e.retryAt??now()+300000);await store.deferRejected(id,new Date(e.retryAt).toISOString());}throw e;}
   const after=await api(refPath);if(after.object.sha!==prepared.commit.sha){const comparison=await api(r.prefix+'/compare/'+prepared.commit.sha+'...'+after.object.sha,{missing:true});if(!comparison||!['ahead','identical'].includes(comparison.status))return {id,planId:p.id,state:'outcome_unknown',expectedCommit:prepared.commit.sha,retry:false};}
  }
  return store.complete(id,{id,planId:p.id,resourceId:r.id,state:'merged',branch:prepared.branch,commit:prepared.commit.sha,parents:[prepared.expectedBase,prepared.head],tree:prepared.tree,historyPreserved:true,forced:false,assessment:input.assessment});
 }};
}
