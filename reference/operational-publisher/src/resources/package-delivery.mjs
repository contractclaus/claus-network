import {createHash} from 'node:crypto';
import {digest,sameValue} from './store.mjs';
export const packageInputs={package_release:['commit','workId'],package_release_info:['actionId']};
const repo='/repos/contractclaus/claus-network',workflow='claus-sdk-release.yml';
const fail=c=>{throw Error('resource_package_'+c);};
const workflowHash='4d48a078b0c36c7f2b4eacc153079bc17db9a8e1a34a79108217b7a6cef0ae75';
export function managedPackages({store,providers,budget,workStatus,now=Date.now}){
 const gh=(p,o)=>providers.call('github',repo+p,o);
 async function runs(commit){const v=await gh('/actions/workflows/'+workflow+'/runs?event=workflow_dispatch&head_sha='+commit+'&per_page=100');const found=v.workflow_runs.filter(x=>x.head_sha===commit&&x.display_title==='Claus SDK '+commit);if(found.length>1)fail('multiple_original_runs');return found[0]??null;}
 async function info(id,a){
  const run=await runs(a.input.commit);if(!run)return {actionId:id,state:'dispatch_outcome_unknown',retry:false};
  if(run.run_attempt!==1)fail('original_run_required');
  await budget('commit',id,a.prepared.maximum,'build');
  const result={actionId:id,runId:run.id,source:a.input.commit,version:a.prepared.version,state:run.status,conclusion:run.conclusion,runUrl:run.html_url,maximumMicroUsd:a.prepared.maximum,meaning:'One original SDK workflow. Maximum authorization is not an invoice. Publication requires the x64 and ARM64 delivery stages and a provenance attestation.'};
  if(run.status==='completed'&&run.conclusion==='success'){
   const release=await gh('/releases/tags/sdk-v'+a.prepared.version);if(release.draft||release.tag_name!=='sdk-v'+a.prepared.version)fail('release_mismatch');
   result.releaseUrl=release.html_url;result.assets=release.assets.map(x=>({name:x.name,bytes:x.size,url:x.browser_download_url,digest:x.digest??null}));
  }
  return result;
 }
 return {async call(operation,input,requestId){
  if(operation==='package_release_info'){const a=await store.get('action',input.actionId);if(a?.operation!=='package_release')fail('action_unknown');return info(input.actionId,a);}
  if(!/^[a-f0-9]{40}$/.test(input.commit??'')||!/^nw_[a-z0-9_-]{1,80}$/.test(input.workId??'')||!['ready','working','waiting'].includes(await workStatus(input.workId)))fail('active_source_work_required');
  if(typeof requestId!=='string'||!requestId||requestId.length>200)fail('request_invalid');
  const id='act_'+digest(['owner',requestId]).slice(0,24),old=await store.get('action',id);if(old&&(old.operation!==operation||!sameValue(old.input,input)))fail('request_conflict');
  let a=old;
  if(!a){
   const [head,w,pkg]=await Promise.all([gh('/git/ref/heads/main'),gh('/contents/.github/workflows/'+workflow+'?ref='+input.commit),gh('/contents/interfaces/sdk-package.json?ref='+input.commit)]);
   if(head.object.sha!==input.commit||createHash('sha256').update(Buffer.from(w.content,'base64')).digest('hex')!==workflowHash)fail('source_or_workflow_changed');
   const meta=JSON.parse(Buffer.from(pkg.content,'base64'));if(meta.name!=='@claus/network-sdk'||!/^\d+\.\d+\.\d+$/.test(meta.version))fail('package_invalid');
   const prepared={version:meta.version,maximum:'1000000',ref:'claus-sdk-source-'+input.commit,createdAt:new Date(now()).toISOString()};a=(await store.begin(id,operation,input,prepared)).row.result;
  }
  const claim=await store.put('package-source',input.commit,{actionId:id});if(claim.value.actionId!==id)fail('original_delivery_requires_reconciliation');
  await budget('reserve',id,a.prepared.maximum,'build');
  if(await runs(input.commit))return info(id,a);
  let tag=await gh('/git/ref/tags/'+a.prepared.ref,{missing:true});
  if(!tag){const tagId='package-tag:'+input.commit;await store.begin(tagId,'package_tag',{source:input.commit},{});if(await store.dispatch(tagId))await gh('/git/refs',{method:'POST',body:{ref:'refs/tags/'+a.prepared.ref,sha:input.commit}});tag=await gh('/git/ref/tags/'+a.prepared.ref,{missing:true});}
  if(tag?.object?.sha!==input.commit)fail('source_reference_unavailable');
  if(await store.dispatch(id))await gh('/actions/workflows/'+workflow+'/dispatches',{method:'POST',body:{ref:a.prepared.ref}});
  return info(id,a);
 }};
}
