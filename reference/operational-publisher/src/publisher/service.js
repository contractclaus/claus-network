import {OperationsHost} from './host.js';
import {target,hash,sha,validateManifest,validateChanges,patch,denyNewAuthority} from './policy.js';
import {validateProgram} from './program.js';
import {publicationControls} from './controls.js';
import {trustedReview} from './review-evidence.js';
import {NativeArchive} from './native-archive.js';

const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const equal=(a,b)=>canonical(a)===canonical(b);
const fail=code=>{throw Error('publisher_'+code);};
const deploymentId=v=>{if(!/^dpl_[A-Za-z0-9]+$/.test(v??''))fail('deployment_invalid');return v;};
const projectView=p=>({id:p.id,name:p.name,targets:{production:{id:p.targets?.production?.id??null}},crons:{definitions:(p.crons?.definitions??[]).map(({path,schedule})=>({path,schedule}))}});
const deploymentView=d=>({id:d.id,url:d.url,projectId:d.projectId,readyState:d.readyState,state:d.state,meta:{clausOperationId:d.meta?.clausOperationId,clausSourceHash:d.meta?.clausSourceHash}});

// No caller-selected provider path, URL, environment, build command or SQL.
// The original release and its completed review come from a read-only DB role.
export function createPublisher({repository,ledger,host=new OperationsHost(),reviewEvidence=trustedReview,controls,nativeArchive}){
 const control=()=>controls??=publicationControls();
 const retainNative=(scope,deployment,manifest)=>scope==='native'?(nativeArchive??=new NativeArchive({host})).retain(deployment,manifest):Promise.resolve(null);
 async function context(scope){target(scope);const c=await repository.current(scope);if(!c)fail('scope_missing');validateManifest(c.manifest);return c;}
 async function release(scope,id){if(!/^op_[a-f0-9]{24}$/.test(id??''))fail('release_invalid');const r=await repository.release(id);if(!r||r.scope!==scope)fail('release_missing');return r;}
 async function bound(scope,id){
  deploymentId(id);const c=await context(scope);if(c.deployment===id)return {c,manifest:c.manifest};
  const r=await repository.byDeployment(scope,id);if(!r)fail('deployment_unbound');
  const manifest=r.base_deployment===id?r.manifest.map(f=>{const old=r.files.find(x=>x.path===f.path);return old?{path:f.path,sha:sha(old.before),size:Buffer.byteLength(old.before)}:f;}):r.manifest;
  validateManifest(manifest);return {c,r,manifest};
 }
 async function reviewed(r,c){
  if(!c.enabled||c.revision!==r.base_revision||c.deployment!==r.base_deployment)fail('base_changed');
  const settings=await repository.settings();if(!settings.enabled)fail('disabled');
  validateChanges(r.scope,r.changes);validateManifest(r.manifest);
  if(!Array.isArray(r.files)||r.files.length!==r.changes.length||new Set(r.files.map(f=>f.path)).size!==r.files.length)fail('files_invalid');
  const expected=structuredClone(c.manifest);
  for(const change of r.changes){const file=r.files.find(f=>f.path===change.path),ref=expected.find(f=>f.path===change.path);if(!file||!ref||sha(file.before)!==ref.sha||Buffer.byteLength(file.before)!==ref.size||patch(file.before,change)!==file.content)fail('source_binding');denyNewAuthority(file.before,file.content);if(r.scope!=='web')validateProgram(file.path==='src/application/main.js'?{version:2,lines:file.content.split('\n')}:JSON.parse(file.content));ref.sha=sha(file.content);ref.size=Buffer.byteLength(file.content);}
  if(!equal(expected,r.manifest)||hash(expected)!==r.source_hash)fail('manifest_binding');
  const e=await repository.review(r.review_effect);if(!e||e.project_id!==r.build_id||e.kind!=='model'||e.status!=='completed')fail('review_incomplete');
  const output=await reviewEvidence(e,'operational');
  let input,result;try{input=JSON.parse(e.input.input[0].content);const v=output.message.content;result=JSON.parse((Array.isArray(v)?v.map(x=>x.text??'').join(''):String(v)).replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{fail('review_invalid');}
  if(input.scope!==r.scope||input.sourceHash!==r.source_hash||input.baseDeployment!==r.base_deployment||!equal(input.changes,r.changes)||!equal(input.files,r.files))fail('review_binding');
  if(result.approved!==true||result.withinScope!==true||result.preservesBehaviour!==true||typeof result.summary!=='string')fail('review_rejected');
 }
 async function once(key,input,action,reconcile){
  const state=await ledger.reserve(key,input);
  if(!state.created){if(state.row.status==='completed')return state.row.result;const known=await reconcile();if(known){await ledger.complete(key,known);return known;}fail('outcome_unknown');}
  // The durable reservation is committed before the provider call. On error it
  // remains held, even after a process crash. Never repeat a lost deployment.
  const result=await action();await ledger.complete(key,result);return result;
 }
 async function reconcileDeployment(r,required=false){
  const key='deploy:'+r.id,entry=await ledger.get(key);
  if(!entry){if(required)fail('publication_not_proven');return host.reconcile(r.scope,r.id,r.source_hash,r.deployment?.id);}
  if(entry.input_hash!==hash({scope:r.scope,base:r.base_deployment,sourceHash:r.source_hash})||!['reserved','completed'].includes(entry.status))fail('release_binding');
  const known=entry.status==='completed'?entry.result?.id:r.deployment?.id;
  if(entry.status==='completed'&&!known)fail('publication_not_proven');
  const actual=await host.reconcile(r.scope,r.id,r.source_hash,known);
  if(!actual){if(required)fail('outcome_unknown');return null;}
  if(known&&actual.id!==known)fail('release_binding');
  if(r.deployment?.id&&r.deployment.id!==actual.id)fail('release_binding');
  // Only resolve the original reserved provider call. This path never creates
  // another deployment, even if the response from that call was lost.
  if(entry.status==='reserved')await ledger.complete(key,actual);
  return actual;
 }
 return {async call(operation,scope,args){
  if(!Array.isArray(args))fail('input_invalid');target(scope);
  const arities={project:0,baseline:2,read:2,deployment:1,reconcile:3,verify:3,deploy:5,promote:2,restored:1,activate:1,finishRollback:1,adopt:1};
  if(!Object.hasOwn(arities,operation)||args.length!==arities[operation])fail('operation_denied');
  const c=await context(scope);
  if(operation==='adopt'){if(scope!=='native'||args[0]!==c.deployment||(await host.project(scope)).targets?.production?.id!==args[0])fail('base_changed');return control().adoptNative(args[0]);}
  if(operation==='activate'||operation==='finishRollback'){
   const r=await release(scope,args[0]),old=await control().activated('operation',r.id,operation==='activate'?'activate':'rollback');
   if(old&&old.deployment===c.deployment&&old.revision===c.revision)return old;
   const rollback=operation==='finishRollback';
   let manifest=r.manifest,id=r.deployment?.id;
   if(rollback){
    if(!['rollback_pending','rolling_back'].includes(r.state)||!r.deployment?.id)fail('rollback_changed');
    const journal=await ledger.get((r.promote_started?'promote:':'deploy:')+r.id);
    if(!journal||!['reserved','completed'].includes(journal.status))fail('publication_not_proven');
    if(r.promote_started&&journal.input_hash!==hash({scope,base:r.base_deployment,target:r.deployment.id}))fail('release_binding');
    if(!r.promote_started&&journal.input_hash!==hash({scope,base:r.base_deployment,sourceHash:r.source_hash}))fail('release_binding');
    id=r.base_deployment;manifest=r.manifest.map(f=>{const old=r.files.find(x=>x.path===f.path);return old?{path:f.path,sha:sha(old.before),size:Buffer.byteLength(old.before)}:f;});
   }else{
    await reviewed(r,c);if(r.state!=='verified'||!r.promote_started)fail('publication_not_proven');
    const deployed=await reconcileDeployment(r,true);if(deployed.id!==id)fail('release_binding');
    const key='promote:'+r.id,journal=await ledger.get(key);
    if(!journal||journal.input_hash!==hash({scope,base:r.base_deployment,target:id})||!['reserved','completed'].includes(journal.status))fail('publication_not_proven');
    if((await host.project(scope)).targets?.production?.id!==id)fail('production_changed');
    if(journal.status==='completed'&&(!journal.result?.promoted||journal.result.id!==id))fail('publication_not_proven');
    if(journal.status==='reserved')await ledger.complete(key,{promoted:true,id});
   }
   const actual=await host.api('/v13/deployments/'+deploymentId(id),{},scope);if(actual.projectId!==target(scope).project)fail('deployment_binding');
   const proof=await host.verify(scope,{id,url:'https://'+actual.url},manifest,true);
   const standby=await retainNative(scope,id,manifest);
   const schedules=p=>(p??[]).map(({path,schedule})=>({path,schedule})).sort((a,b)=>a.path.localeCompare(b.path));
   const live=await host.project(scope);if(live.targets?.production?.id!==id)fail('production_changed');
   if(!equal(schedules(live.crons?.definitions),schedules(c.crons)))fail('schedule_changed');
   return rollback?control().rollbackOperation(c,r,manifest,{passed:true,rollback:{completedAt:new Date().toISOString(),verification:proof},standby}):control().activateOperation(c,r,{passed:true,sourceHash:r.source_hash,reviewEffect:r.review_effect,production:proof,standby,verifiedBy:'fixed-publisher'});
  }
  if(operation==='project')return projectView(await host.project(scope));
  if(operation==='baseline'){const [id,manifest]=args;if(id!==c.deployment||!equal(manifest,c.manifest))fail('base_changed');return projectView(await host.baseline(scope,id,c.manifest));}
  if(operation==='read'){const [id,file]=args,b=await bound(scope,id);if(!target(scope).paths.some(p=>p.test(file?.path))||!b.manifest.some(f=>equal(f,file)))fail('file_denied');return host.read(scope,id,file);}
  if(operation==='deployment'){const [id]=args;await bound(scope,id);return deploymentView(await host.api('/v13/deployments/'+id,{},scope));}
  if(operation==='restored'){await bound(scope,args[0]);return host.restored(scope,args[0]);}
  if(operation==='reconcile'){const [id,sourceHash,known]=args,r=await release(scope,id);if(sourceHash!==r.source_hash||known&&known!==r.deployment?.id)fail('release_binding');return reconcileDeployment(r);}
  if(operation==='verify'){const [d,manifest,production]=args,b=await bound(scope,d?.id);if(typeof production!=='boolean'||!equal(manifest,b.manifest))fail('manifest_binding');const actual=await host.api('/v13/deployments/'+d.id,{},scope);if(actual.projectId!==target(scope).project||d.url!=='https://'+actual.url)fail('deployment_binding');if(production&&(await host.project(scope)).targets?.production?.id!==d.id)fail('production_changed');return host.verify(scope,{id:d.id,url:'https://'+actual.url},b.manifest,production);}
  if(operation==='deploy'){
   const [base,manifest,files,id,sourceHash]=args,r=await release(scope,id);await reviewed(r,c);
   if(!r.deploy_started||!['review_pending','deploying'].includes(r.state)||base!==r.base_deployment||sourceHash!==r.source_hash||!equal(manifest,r.manifest)||!equal(files,r.files))fail('release_binding');
   await host.baseline(scope,c.deployment,c.manifest);
   return once('deploy:'+id,{scope,base,sourceHash},async()=>{const latest=await release(scope,id);await reviewed(latest,await context(scope));if(!latest.deploy_started||!['review_pending','deploying'].includes(latest.state))fail('release_binding');return host.deploy(scope,base,r.manifest,r.files,id,sourceHash);},()=>host.reconcile(scope,id,sourceHash,r.deployment?.id));
  }
  if(operation==='promote'){
   const [base,d]=args;deploymentId(base);deploymentId(d?.id);
   const r=await repository.promotion(scope,base,d.id);if(!r)fail('promotion_unbound');
   const rollback=base===r.deployment?.id&&d.id===r.base_deployment;
   const enabled=await repository.settings();if(!c.enabled||!enabled.enabled)fail('disabled');
   if(rollback){if(r.state!=='rolling_back'||c.deployment!==base||c.revision!==r.base_revision+1)fail('rollback_changed');}
   else{await reviewed(r,c);if(!r.promote_started||r.deployment?.id!==d.id||!['deploying','verified'].includes(r.state))fail('promotion_unbound');const original=await reconcileDeployment(r,true);if(original.id!==d.id)fail('promotion_unbound');}
   const b=await bound(scope,d.id),actual=await host.api('/v13/deployments/'+d.id,{},scope);if(actual.projectId!==target(scope).project)fail('deployment_binding');
   await host.verify(scope,{id:d.id,url:'https://'+actual.url},b.manifest);
   await retainNative(scope,d.id,b.manifest);
   const crons=p=>(p??[]).map(({path,schedule})=>({path,schedule})).sort((a,b)=>a.path.localeCompare(b.path));
   if(!equal(crons((await host.project(scope)).crons?.definitions),crons(c.crons)))fail('schedule_changed');
   return once((rollback?'rollback:':'promote:')+r.id,{scope,base,target:d.id},async()=>{
    const fresh=await context(scope),settings=await repository.settings();if(!fresh.enabled||!settings.enabled||fresh.revision!==c.revision||fresh.deployment!==c.deployment)fail('base_changed');
    await host.promote(scope,base,{id:d.id});return {promoted:true,id:d.id};
   },async()=>await host.restored(scope,d.id)?{promoted:true,id:d.id}:null);
  }
 }};
}
