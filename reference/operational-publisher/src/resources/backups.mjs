import {digest,sameValue} from './store.mjs';
export const backupInputs={backup_start:['workId','reason'],backup_info:['backupId']};
const executorCommit='096652ccf25d34bb4107320c288b674e7c1ec10c';
const repo='/repos/contractclaus/claus-network-recovery';
const workflow='claus-database-backup.yml';
const fail=s=>{throw Error('resource_backup_'+s);};
const validId=v=>typeof v==='string'&&/^bkp_[a-f0-9]{24}$/.test(v);
export function managedBackups({store,providers,budget,workStatus,now=Date.now}){
 const gh=(path,options)=>providers.call('github',repo+path,options);
 async function original(id){if(!validId(id))fail('identifier_invalid');const r=await store.get('backup-request',id);if(!r)fail('not_found');return r;}
 function verifyRun(run,p){if(run.head_sha!==p.sourceCommit||run.display_title!=='Claus database recovery ('+p.backupId+')'||run.event!=='workflow_dispatch')fail('run_identity_changed');return run;}
 async function findRun(p){
  const saved=await store.get('backup-run',p.backupId);
  if(saved)return verifyRun(await gh('/actions/runs/'+saved.runId),p);
  for(let page=1;page<=3;page++){
   const result=await gh('/actions/workflows/'+workflow+'/runs?event=workflow_dispatch&head_sha='+p.sourceCommit+'&created='+encodeURIComponent('>='+p.createdAt)+'&per_page=100&page='+page);
   const found=result.workflow_runs.filter(r=>r.display_title==='Claus database recovery ('+p.backupId+')');
   if(found.length>1)fail('duplicate_run');
   if(found.length){const run=verifyRun(found[0],p);await store.put('backup-run',p.backupId,{runId:run.id});return run;}
   if(result.workflow_runs.length<100)break;
  }
  return null;
 }
 async function info(p){
  const run=await findRun(p);
  if(!run)return {backupId:p.backupId,actionId:p.actionId,workId:p.workId,state:'dispatch_unknown',retry:false,maximumAuthorizedMicroUsd:'400000',next:'Read backup_info for this original backupId. Do not start a replacement backup.'};
  await budget('commit',p.backupId,'400000','storage');
  const artifacts=run.status==='completed'?(await gh('/actions/runs/'+run.id+'/artifacts?per_page=100')).artifacts:[];
  return {backupId:p.backupId,actionId:p.actionId,workId:p.workId,state:run.status,conclusion:run.conclusion,runId:run.id,runAttempt:run.run_attempt,runUrl:run.html_url,sourceCommit:p.sourceCommit,maximumAuthorizedMicroUsd:'400000',artifacts:artifacts.map(a=>({id:a.id,name:a.name,bytes:a.size_in_bytes,expired:a.expired,digest:a.digest??null})),storagePrefix:'objects/recurring-v5/manual/'+p.backupId+'/',restorationProven:false,meaning:'Independent encrypted backup execution. A successful workflow retains its exact remote-verified pointer; it is not a production restore or a provider invoice. Read the pointer and original artifacts before restoring into an isolated target. Never rerun this original workflow.'};
 }
 return {async call(operation,input,requestId){
  if(operation==='backup_info')return info(await original(input.backupId));
  if(operation!=='backup_start'||typeof requestId!=='string'||!requestId||requestId.length>200)fail('request_invalid');
  const actionId='act_'+digest(['owner',requestId]).slice(0,24),prior=await store.get('action',actionId);
  if(prior&&(prior.operation!==operation||!sameValue(prior.input,input)))fail('request_conflict');
  if(prior?.output)return prior.output;
  let p=prior?.prepared;
  if(!p){
   if(!/^nw_[a-z0-9_-]{1,80}$/.test(input.workId??'')||!['ready','working','waiting'].includes(await workStatus(input.workId))||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>1000||/-----BEGIN|Bearer\s|(?:token|secret|password|api[-_]?key)\s*[=:]\s*\S{8}/i.test(input.reason))fail('work_required');
   const identity=await gh('');if(!identity.private||identity.owner?.login!=='contractclaus')fail('repository_identity_changed');
   await gh('/git/commits/'+executorCommit);
   p={backupId:'bkp_'+digest(actionId).slice(0,24),actionId,sourceCommit:executorCommit,tag:'claus-recovery-'+executorCommit,createdAt:new Date(now()).toISOString(),workId:input.workId,reason:input.reason};
   p=(await store.begin(actionId,operation,input,p)).row.result.prepared;
  }
  const existing=await findRun(p);if(existing)return store.complete(actionId,await info(p));
  const tagPath='/git/ref/tags/'+p.tag;let tag=await gh(tagPath,{missing:true});
  if(!tag){
   const tagAction='backup-tag:'+p.sourceCommit;await store.begin(tagAction,'backup_tag',{commit:p.sourceCommit},{});
   if(await store.dispatch(tagAction))await gh('/git/refs',{method:'POST',body:{ref:'refs/tags/'+p.tag,sha:p.sourceCommit}});
   tag=await gh(tagPath,{missing:true});
  }
  if(!tag)return {backupId:p.backupId,actionId,state:'reference_unknown',retry:false};
  if(tag.object.sha!==p.sourceCommit)fail('reference_changed');
  await budget('reserve',p.backupId,'400000','storage');
  await store.put('backup-request',p.backupId,p);
  await store.put('backup-allowance',p.backupId,{version:3,id:p.backupId,requestId:p.backupId,attempts:1,maximum:400000,createdAt:p.createdAt,expiresAt:new Date(Date.parse(p.createdAt)+36*3600000).toISOString(),purpose:'Owner-requested read-only encrypted database and owned-object recovery snapshot; one immutable attempt, retained30days.'});
  if(await store.dispatch(actionId)){
   await gh('/actions/workflows/'+workflow+'/dispatches',{method:'POST',body:{ref:p.tag,inputs:{requestId:p.backupId}}});
  }
  const result=await info(p);if(result.state==='dispatch_unknown')return result;
  return store.complete(actionId,result);
 }};
}
