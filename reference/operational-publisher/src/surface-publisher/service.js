import {publicationControls} from '../publisher/controls.js';
import {SurfaceHost} from './host.js';
import {surfaceProject,validateSource,sourceHash,applyChanges} from './source.js';
import {trustedReview} from '../publisher/review-evidence.js';
import {hash as requestHash} from '../publisher/policy.js';
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const equal=(a,b)=>canonical(a)===canonical(b);
const fail=code=>{throw Error('surface_'+code);};
const validId=id=>/^sr_[a-zA-Z0-9_]{1,100}$/.test(id??'');

// This service is fixed operator code. No raw provider path, URL, environment,
// project selection or deployment command crosses the agent-facing boundary.
export function createSurfacePublisher({repository,ledger,host=new SurfaceHost(),reviewEvidence=trustedReview,controls}){
 const control=()=>controls??=publicationControls();
 async function current(){const c=await repository.surfaceCurrent();if(!c||c.project_id!==surfaceProject)fail('scope_changed');return c;}
 async function release(id,hash){
  if(!validId(id)||!/^[a-f0-9]{64}$/.test(hash??''))fail('release_invalid');
  const r=await repository.surfaceRelease(id);if(!r||r.source_hash!==hash||validateSource(r.files)!==hash)fail('release_binding');return r;
 }
 async function reviewed(r,c){
  if(!c.enabled||c.revision!==r.base_revision||!(await repository.settings()).enabled)fail('disabled_or_revision_conflict');
  if(!/^sr_[a-f0-9]{24}$/.test(r.id)||!r.build_id||!r.review_effect)fail('review_missing');
  const base=await repository.surfaceRelease(c.active_id);if(!base||sourceHash(base.files)!==base.source_hash||!equal(applyChanges(base.files,r.changes),r.files))fail('base_binding');
  const e=await repository.review(r.review_effect);if(!e||e.project_id!==r.build_id||e.kind!=='model'||e.status!=='completed')fail('review_incomplete');
  // Recovery of a provider response is performed by the separate payer. A
  // Native-written recovery object cannot replace the original evidence.
  const output=await reviewEvidence(e,'surface');
  let input,result;
  try{input=JSON.parse(e.input.input[0].content);const content=output.message.content;result=JSON.parse((Array.isArray(content)?content.map(x=>x.text??'').join(''):String(content)).replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{fail('review_invalid');}
  if(input.sourceHash!==r.source_hash||!equal(input.changes,r.changes)||!equal(input.files,r.files.filter(f=>r.changes.some(c=>c.path===f.path))))fail('review_binding');
  if(result.approved!==true||result.withinScope!==true||result.preservesBehaviour!==true||typeof result.summary!=='string')fail('review_rejected');
 }
 async function deployment(r,known){
  if(known!=null&&(!/^dpl_[a-zA-Z0-9]+$/.test(known)||known!==r.deployment?.id))fail('deployment_binding');
  return host.reconcile(surfaceProject,r.id,r.source_hash,known??r.deployment?.id);
 }
 async function reconcileDeployment(r,c,required=false){
  const key='surface:deploy:'+r.id,entry=await ledger.get(key);
  if(!entry){if(required)fail('publication_not_proven');return deployment(r,r.deployment?.id);}
  const binding={project:surfaceProject,id:r.id,sourceHash:r.source_hash,baseRevision:r.base_revision,baseId:c.active_id};
  if(entry.input_hash!==requestHash(binding)||!['reserved','completed'].includes(entry.status))fail('deployment_binding');
  const known=entry.status==='completed'?entry.result?.id:r.deployment?.id;
  if(entry.status==='completed'&&!known)fail('publication_not_proven');
  const actual=await host.reconcile(surfaceProject,r.id,r.source_hash,known);if(!actual){if(required)fail('outcome_unknown');return null;}
  if(known&&actual.id!==known||r.deployment?.id&&r.deployment.id!==actual.id)fail('deployment_binding');
  if(entry.status==='reserved')await ledger.complete(key,actual);
  return actual;
 }
 return {async call(operation,args){
  const arities={project:1,prepare:4,deploy:4,reconcile:4,source:4,verify:4,activate:1,monitor:0};
  if(!Object.hasOwn(arities,operation)||!Array.isArray(args)||args.length!==arities[operation])fail('operation_denied');
  const c=await current();
  if(operation==='activate'){
   const r=await repository.surfaceRelease(args[0]);if(!r)fail('release_missing');
   const old=await control().activated('surface',r.id);if(old&&old.active_id===c.active_id&&old.revision===c.revision)return old;
   await reviewed(r,c);if(r.state!=='verified')fail('activation_conflict');
   const actual=await reconcileDeployment(r,c,true);if(actual.state!=='READY')fail('publication_not_proven');
   await host.verifySource(actual.id,r.files,r.id,r.source_hash);
   const proof=await host.verify(actual.url,r.id,r.source_hash,true);return control().activateSurface(c,r,{...proof,reviewEffect:r.review_effect,verifiedBy:'fixed-publisher'});
  }
  if(operation==='monitor'){
   if(!c.enabled)return {state:'disabled'};if(c.last_checked&&Date.now()-Date.parse(c.last_checked)<60000)return {state:'recent'};
   const r=await repository.surfaceRelease(c.active_id);if(!r)fail('release_missing');let healthy=false;
   try{await host.verify(r.deployment.url,r.id,r.source_hash,true);healthy=true;}catch{}
   const updated=await control().monitorSurface(c,healthy);if(!updated)return {state:'recent'};
   if(!healthy&&updated.failures>=2&&updated.fallback_id){
    const previous=await repository.surfaceRelease(updated.fallback_id);if(!previous)fail('fallback_missing');
    if(validateSource(previous.files)!==previous.source_hash)fail('fallback_invalid');
    await host.verifySource(previous.deployment.id,previous.files,previous.id,previous.source_hash);
    const proof=await host.verify(previous.deployment.url,previous.id,previous.source_hash,true);
    const next=await control().rollbackSurface(updated,await repository.surfaceRelease(updated.active_id),{reason:'two_failed_public_health_checks',fallback:proof,at:new Date().toISOString()});
    return {changed:true,revision:next.revision,activeId:next.active_id};
   }
   return {state:healthy?'healthy':'unavailable',id:r.id,failures:updated.failures};
  }
  if(operation==='project'){if(args[0]!==surfaceProject)fail('scope_changed');await host.assertProject(surfaceProject);return {projectId:surfaceProject};}
  if(operation==='prepare'||operation==='deploy'){
   const [project,files,id,sourceDigest]=args;if(project!==surfaceProject)fail('scope_changed');const r=await release(id,sourceDigest);await reviewed(r,c);
   if(!equal(files,r.files))fail('source_binding');
   const binding={project:surfaceProject,id,sourceHash:sourceDigest,baseRevision:c.revision,baseId:c.active_id},preparedKey='surface:prepare:'+id;
   if(operation==='prepare'){
    if(r.deploy_started||r.state!=='approved')fail('preparation_too_late');
    const state=await ledger.reserve(preparedKey,binding);
    if(state.row.status==='completed')return state.row.result;
    // This reservation makes no provider call. Resuming an interrupted prepare
    // completes only its durable authorization, never an external side effect.
    const result={prepared:true,id,sourceHash:sourceDigest};await ledger.complete(preparedKey,result);return result;
   }
   if(!r.deploy_started||r.state!=='deploying'||!equal(files,r.files))fail('deployment_binding');
   const prepared=await ledger.get(preparedKey);
   if(!prepared||prepared.status!=='completed'){
    // Old deployments can predate this journal. Never treat a missing new
    // journal row as permission to repeat their existing provider attempt.
    const existing=await deployment(r,r.deployment?.id);if(!existing)fail('outcome_unknown');return existing;
   }
   if(prepared.input_hash!==requestHash(binding)||prepared.result?.prepared!==true)fail('preparation_binding');
   const key='surface:deploy:'+id,state=await ledger.reserve(key,binding);
   if(!state.created){
    if(state.row.status==='completed')return state.row.result;
    const existing=await deployment(r,r.deployment?.id);if(!existing)fail('outcome_unknown');await ledger.complete(key,existing);return existing;
   }
   await host.assertProject(surfaceProject);
   const fresh=await release(id,sourceDigest),control=await current();await reviewed(fresh,control);
   if(control.active_id!==c.active_id||control.revision!==c.revision||fresh.state!=='deploying'||!fresh.deploy_started)fail('deployment_binding');
   const result=await host.deploy(surfaceProject,r.files,r.id,r.source_hash);await ledger.complete(key,result);return result;
  }
  if(operation==='reconcile'){
   const [project,id,hash,known]=args;if(project!==surfaceProject)fail('scope_changed');const r=await release(id,hash);
   if(known!=null&&known!==r.deployment?.id)fail('deployment_binding');
   // Once the base revision has moved, this is historical readback only.
   return c.revision===r.base_revision?reconcileDeployment(r,c):deployment(r,known);
  }
  if(operation==='source'){
   const [known,files,id,hash]=args,r=await release(id,hash);if(!equal(files,r.files))fail('source_binding');const actual=await deployment(r,known);if(!actual)fail('outcome_unknown');return host.verifySource(actual.id,r.files,r.id,r.source_hash);
  }
  const [url,id,hash,data]=args,r=await release(id,hash);if(typeof data!=='boolean')fail('input_invalid');
  const actual=await deployment(r,r.deployment?.id);if(!actual||url!==actual.url||actual.state!=='READY')fail('deployment_binding');
  return host.verify(actual.url,r.id,r.source_hash,data);
 }};
}
