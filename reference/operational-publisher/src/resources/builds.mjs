import {createHash} from 'node:crypto';
import {digest} from './store.mjs';
import {buildWorkflow,buildWorkflowPath} from './build-workflow.mjs';
import {repositoryIdentity} from './repository.mjs';
export const buildInputs={build_install:['resourceId'],build_start:['resourceId','commit','architecture','timeoutMinutes','mode','command','cacheKey','context','dockerfile'],build_info:['resourceId','actionId'],build_logs:['resourceId','actionId','jobId','offset'],build_artifact:['resourceId','actionId','artifactId'],build_cancel:['resourceId','actionId'],build_caches:['resourceId','page']};
const fail=c=>{throw Error('resource_build_'+c);};
const priceUrl='https://docs.github.com/en/billing/reference/actions-runner-pricing';
const packageUrl='https://docs.github.com/en/billing/concepts/product-billing/github-packages';
const workflowSha=createHash('sha1').update(Buffer.from('blob '+Buffer.byteLength(buildWorkflow)+'\0'+buildWorkflow)).digest('hex');
const relative=p=>typeof p==='string'&&p.length<=240&&(p==='.'||/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(p)&&!p.split('/').some(p=>p==='..'||p==='.git'));
const action=v=>{if(!/^act_[a-f0-9]{24}$/.test(v??''))fail('action_invalid');return v;};
const positive=v=>{if(!Number.isSafeInteger(v)||v<1)fail('identifier_invalid');return v;};
async function bounded(response,limit){
 if(!response.body)fail('response_missing');let length=0;const chunks=[];
 try{for await(const chunk of response.body){length+=chunk.length;if(length>limit)fail('response_too_large');chunks.push(chunk);}}finally{await response.body.cancel().catch(()=>{});}
 return Buffer.concat(chunks);
}
export async function buildPrices(request=fetch){
 const [r,p]=await Promise.all([request(priceUrl,{redirect:'error',signal:AbortSignal.timeout(15000)}),request(packageUrl,{redirect:'error',signal:AbortSignal.timeout(15000)})]);
 if(!r.ok||!p.ok)fail('pricing_unavailable');
 const [html,packages]=await Promise.all([bounded(r,2000000),bounded(p,2000000)]);
 const rows=[...html.toString().matchAll(/<tr[\s>][\s\S]*?<\/tr>/g)].map(m=>m[0].replace(/<[^>]+>/g,' ').replace(/\s+/g,' '));
 const rates={};for(const [arch,label]of [['amd64','Linux 2-core (x64)'],['arm64','Linux 2-core (arm64)']]){
  const row=rows.find(r=>r.includes(label)),m=row?.match(/\$(\d+\.\d+)/);if(!m)fail('pricing_format_changed');
  rates[arch]=Math.ceil(Number(m[1])*1000000);if(!Number.isSafeInteger(rates[arch])||rates[arch]<=0)fail('pricing_invalid');
 }
 const text=packages.toString().replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
 if(!/Container image storage and bandwidth for the Container registry is currently free\./.test(text))fail('registry_billing_changed');
 return {perMinuteMicroUsd:rates,source:priceUrl,registrySource:packageUrl,registryStorageCurrentlyFree:true,observedAt:new Date().toISOString()};
}
export function managedBuilds({store,providers,budget,request=fetch,now=Date.now,prices=()=>buildPrices(request),environment=process.env}){
 const gh=(p,o)=>providers.call('github',p,o);
 const stamp=()=>new Date(now()).toISOString();
 async function resource(id){const r=await store.get('resource',id);if(!r||r.provider!=='github'||r.owner!=='contractclaus'||!/^claus-[a-z0-9-]+$/.test(r.name)||r.protected)fail('scope_invalid');return r;}
 const prefix=r=>'/repos/contractclaus/'+r.name;
 async function repo(r){const v=await gh(prefix(r));if(v.owner?.login!=='contractclaus'||String(v.id)!==r.providerId)fail('owner_changed');return v;}
 const workflow=(r,ref)=>gh(prefix(r)+'/contents/'+buildWorkflowPath+'?ref='+encodeURIComponent(ref),{missing:true});
 async function startRecord(r,id){const a=await store.get('action',action(id));if(a?.operation!=='build_start'||a.input.resourceId!==r.id)fail('run_not_owned');return a;}
 function assertRun(run,r,id,a){if(run.repository?.id&&String(run.repository.id)!==r.providerId||run.display_title!=='Claus build '+id||run.head_sha!==a.prepared.workflowCommit||run.event!=='workflow_dispatch')fail('run_identity_changed');return run;}
 async function findRun(r,id,a){
  const saved=await store.get('build-run',id);
  if(saved)return assertRun(await gh(prefix(r)+'/actions/runs/'+positive(saved.runId)),r,id,a);
  const search=await store.get('build-search',id),date=a.prepared.createdAt;let page=search?.page??1;
  for(let count=0;count<3;count++,page++){
   const v=await gh(prefix(r)+'/actions/workflows/'+encodeURIComponent(buildWorkflowPath.split('/').at(-1))+'/runs?event=workflow_dispatch&head_sha='+a.prepared.workflowCommit+'&created='+encodeURIComponent('>='+date)+'&per_page=100&page='+page);
   const matches=v.workflow_runs.filter(run=>run.display_title==='Claus build '+id);if(matches.length>1)fail('duplicate_run');
   if(matches.length){const run=assertRun(matches[0],r,id,a);await store.put('build-run',id,{runId:run.id,resourceId:r.id,createdAt:stamp()});return run;}
   if(v.workflow_runs.length<100){page=1;break;}
  }
  if(page!==1||search){const state={page,revision:(search?.revision??0)+1};if(search)await store.change('build-search',id,search.revision,state);else await store.put('build-search',id,state);}
  return null;
 }
 async function run(r,id){const a=await startRecord(r,id),v=await findRun(r,id,a);return {action:a,value:v};}
 async function redirect(path){
  const token=environment.CLAUS_GITHUB_TOKEN;if(!token)fail('access_missing');
  const r=await request('https://api.github.com'+path,{headers:{authorization:'Bearer '+token,accept:'application/vnd.github+json'},redirect:'manual',signal:AbortSignal.timeout(20000)});
  await r.body?.cancel();if(r.status!==302)fail('download_'+r.status);
  const u=new URL(r.headers.get('location'));if(u.protocol!=='https:'||u.username||u.password||!['.blob.core.windows.net','.actions.githubusercontent.com'].some(s=>u.hostname.endsWith(s)))fail('download_origin_changed');return u.href;
 }
 const visible=(v,a,id)=>({actionId:id,runId:v.id,runUrl:v.html_url,state:v.status,conclusion:v.conclusion,attempt:v.run_attempt,sourceCommit:a.input.commit,workflowCommit:a.prepared.workflowCommit,architecture:a.input.architecture??'amd64',maximumAuthorizedMicroUsd:a.prepared.maximum,costMeaning:'Maximum operating authorization, not a provider invoice. Never rerun this run; a new intentional build needs a new request.',image:a.input.mode==='container'?'ghcr.io/contractclaus/'+a.prepared.resource.name+':'+id:null});
 async function info(r,id){
  const {action:a,value:v}=await run(r,id);if(!v)return {actionId:id,state:'outcome_unknown',retry:false,next:'Repeat the original build_start request with its original requestId to reconcile; do not submit a new build.'};
  await budget('commit',id,a.prepared.maximum);
  const [jobs,artifacts]=await Promise.all([gh(prefix(r)+'/actions/runs/'+v.id+'/jobs?per_page=100'),gh(prefix(r)+'/actions/runs/'+v.id+'/artifacts?per_page=100')]);
  return {...visible(v,a,id),jobs:jobs.jobs.map(j=>({id:j.id,name:j.name,state:j.status,conclusion:j.conclusion,startedAt:j.started_at,completedAt:j.completed_at,steps:j.steps?.map(s=>({name:s.name,state:s.status,conclusion:s.conclusion}))})),artifacts:artifacts.artifacts.map(x=>({id:x.id,name:x.name,bytes:x.size_in_bytes,expired:x.expired,expiresAt:x.expires_at,digest:x.digest??null})),artifactRetentionDays:1,next:'Copy useful artifacts to an owned object bucket before their provider expiry. A successful run is not proof of a live service.'};
 }
 async function call(operation,input,requestId){
  const r=await resource(input.resourceId);
  if(operation==='build_info')return info(r,action(input.actionId));
  if(operation==='build_caches'){const page=input.page??1;positive(page);const v=await gh(prefix(r)+'/actions/caches?per_page=100&page='+page);return {total:v.total_count,items:v.actions_caches.filter(c=>c.key.startsWith('claus-owned-')).map(c=>({id:c.id,key:c.key,bytes:c.size_in_bytes,lastAccessedAt:c.last_accessed_at,createdAt:c.created_at})),nextPage:v.actions_caches.length===100?page+1:null};}
  if(operation==='build_logs'||operation==='build_artifact'){
   const {value:v}=await run(r,action(input.actionId));if(!v)fail('run_unresolved');
   if(operation==='build_artifact'){
    const id=positive(input.artifactId),artifact=await gh(prefix(r)+'/actions/artifacts/'+id);if(artifact.workflow_run?.id!==v.id||artifact.expired)fail('artifact_not_available');
    return {runId:v.id,artifactId:id,bytes:artifact.size_in_bytes,digest:artifact.digest??null,url:await redirect(prefix(r)+'/actions/artifacts/'+id+'/zip'),expiresInSeconds:60,private:true};
   }
   const id=positive(input.jobId),job=await gh(prefix(r)+'/actions/jobs/'+id);if(job.run_id!==v.id)fail('job_not_owned');
   const offset=input.offset??0;if(!Number.isSafeInteger(offset)||offset<0)fail('offset_invalid');
   const url=await redirect(prefix(r)+'/actions/jobs/'+id+'/logs'),response=await request(url,{headers:{range:'bytes='+offset+'-'+(offset+47999)},redirect:'error',signal:AbortSignal.timeout(15000)});
   if(!response.ok)fail('logs_unavailable');if(offset&&response.status!==206){await response.body?.cancel();fail('logs_range_unavailable');}
   let text=(await bounded(response,response.status===206?48000:2000000)).toString();if(response.status!==206)text=text.slice(0,48000);
   const secrets=Object.entries(environment).filter(([k,v])=>typeof v==='string'&&v.length>=8&&/(TOKEN|SECRET|PASSWORD|KEY|DATABASE_URL)/.test(k)).map(([,v])=>v);
   for(const value of secrets)text=text.split(value).join('[redacted]');text=text.replace(/(?:Bearer|FlyV1)\s+\S+/gi,'[redacted authorization]');
   return {runId:v.id,jobId:id,offset,text,nextOffset:offset+48000,complete:response.status===206?Number(response.headers.get('content-range')?.split('/').at(-1))<=offset+48000:Buffer.byteLength(text)<48000,untrustedProviderOutput:true};
  }
  if(typeof requestId!=='string'||!requestId||requestId.length>200)fail('request_id_invalid');
  const id='act_'+digest(['owner',requestId]).slice(0,24),existing=await store.get('action',id);
  if(existing&&(existing.operation!==operation||digest(existing.input)!==digest(input)))fail('request_conflict');
  if(existing?.output)return existing.output;
  let prepared=existing?.prepared;
  if(!prepared){
   const remote=await repo(r);
   if(operation==='build_install'){
    const current=await workflow(r,remote.default_branch);if(current&&current.sha!==workflowSha)fail('workflow_exists_preserve_and_reconcile');
    prepared={resource:r,branch:remote.default_branch};
   }else if(operation==='build_start'){
    if(!/^[a-f0-9]{40}$/.test(input.commit??''))fail('source_commit_required');await gh(prefix(r)+'/git/commits/'+input.commit);
    const architecture=input.architecture??'amd64',minutes=input.timeoutMinutes??60,mode=input.mode??'command';
    if(!['amd64','arm64'].includes(architecture)||!Number.isSafeInteger(minutes)||minutes<1||minutes>360||!['command','container'].includes(mode))fail('shape_invalid');
    if(mode==='command'&&(typeof input.command!=='string'||!input.command.trim()||Buffer.byteLength(input.command)>24000)||mode==='container'&&input.command)fail('command_invalid');
    if(input.cacheKey!==undefined&&!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.cacheKey))fail('cache_key_invalid');
    if(!relative(input.context??'.')||!relative(input.dockerfile??'Dockerfile'))fail('source_path_invalid');
    const definition=await store.get('build-definition',r.id+':'+workflowSha),installed=await workflow(r,remote.default_branch);
    if(!definition||installed?.sha!==workflowSha||(await workflow(r,definition.commit))?.sha!==workflowSha)fail('install_current_workflow_first');
    const pricing=await prices(),maximum=String(Math.ceil(pricing.perMinuteMicroUsd[architecture]*(minutes+2)*1.1)+500000);
    prepared={resource:r,createdAt:stamp(),workflowCommit:definition.commit,workflowSha,reference:'claus-build-'+workflowSha,pricing,maximum,dispatchInput:{action:id,source:input.commit,runner:architecture==='arm64'?'ubuntu-24.04-arm':'ubuntu-24.04',minutes:String(minutes),mode,command:Buffer.from(input.command??'').toString('base64'),cache:input.cacheKey??'default',context:input.context??'.',dockerfile:input.dockerfile??'Dockerfile'}};
   }else if(operation==='build_cancel'){const target=await run(r,action(input.actionId));if(!target.value)fail('run_unresolved');prepared={resource:r,runId:target.value.id};}
   else fail('operation_invalid');
   const started=await store.begin(id,operation,input,prepared);prepared=started.row.result.prepared;if(started.row.result.output)return started.row.result.output;
  }
  const complete=result=>store.complete(id,{id,...result});
  if(operation==='build_install'){
   let current=await workflow(r,prepared.branch);if(current&&current.sha!==workflowSha)fail('workflow_changed');
   if(!current&&await store.dispatch(id))await gh(prefix(r)+'/contents/'+buildWorkflowPath,{method:'PUT',body:{branch:prepared.branch,message:'Install owned build runner\n\nClaus-Action: '+id,content:Buffer.from(buildWorkflow).toString('base64'),author:repositoryIdentity,committer:repositoryIdentity}});
   current=await workflow(r,prepared.branch);if(current?.sha!==workflowSha)return {id,state:'outcome_unknown',retry:false};
   const head=await gh(prefix(r)+'/git/ref/heads/'+encodeURIComponent(prepared.branch));if((await workflow(r,head.object.sha))?.sha!==workflowSha)fail('workflow_changed');
   await store.put('build-definition',r.id+':'+workflowSha,{commit:head.object.sha,workflowSha,createdAt:stamp()});
   return complete({resourceId:r.id,installed:true,workflowSha,workflow:buildWorkflowPath,automaticTriggers:false,runningBuildCreated:false});
  }
  if(operation==='build_cancel'){
   const target=await run(r,action(input.actionId));if(target.value?.status==='completed')return complete({cancelRequested:false,alreadyCompleted:true,runId:prepared.runId});
   if(await store.dispatch(id))await gh(prefix(r)+'/actions/runs/'+prepared.runId+'/cancel',{method:'POST',body:{}});
   return complete({runId:prepared.runId,cancelRequested:true,completionMustBeObserved:true,maximumReservationRetained:true});
  }
  const a={input,prepared},known=await findRun(r,id,a);if(known){await budget('commit',id,prepared.maximum);return complete(visible(known,a,id));}
  let tag=await gh(prefix(r)+'/git/ref/tags/'+prepared.reference,{missing:true});
  if(!tag){
   const step='build-reference:'+r.id+':'+workflowSha;await store.begin(step,'build_reference',{commit:prepared.workflowCommit},{});
   if(await store.dispatch(step))await gh(prefix(r)+'/git/refs',{method:'POST',body:{ref:'refs/tags/'+prepared.reference,sha:prepared.workflowCommit}});
   tag=await gh(prefix(r)+'/git/ref/tags/'+prepared.reference,{missing:true});
  }
  if(!tag)return {id,state:'reference_outcome_unknown',retry:false};if(tag.object.sha!==prepared.workflowCommit)fail('reference_changed');
  if((await workflow(r,prepared.workflowCommit))?.sha!==prepared.workflowSha)fail('workflow_changed');
  await budget('reserve',id,prepared.maximum);
  if(await store.dispatch(id)){
   try{
    const accepted=await gh(prefix(r)+'/actions/workflows/'+encodeURIComponent(buildWorkflowPath.split('/').at(-1))+'/dispatches',{method:'POST',body:{ref:prepared.reference,inputs:prepared.dispatchInput,return_run_details:true}});
    if(accepted?.workflow_run_id)await store.put('build-run',id,{runId:positive(accepted.workflow_run_id),resourceId:r.id,createdAt:stamp()});
   }catch(e){if([400,401,402,403,404,422].includes(e.status)){await budget('cancel',id,prepared.maximum);return complete({state:'rejected',error:e.message,buildCostAuthorizationCancelled:true});}throw e;}
  }
  const started=await findRun(r,id,a);if(!started)return {id,state:'outcome_unknown',retry:false,maximumReservedMicroUsd:prepared.maximum,next:'Reconcile the same requestId; do not create another build.'};
  await budget('commit',id,prepared.maximum);return complete(visible(started,a,id));
 }
 return {call};
}
