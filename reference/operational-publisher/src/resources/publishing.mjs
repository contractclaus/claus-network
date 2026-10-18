import {createHash} from 'node:crypto';
import {repositoryIdentity} from './repository.mjs';
const sha=(bytes,algorithm='sha256')=>createHash(algorithm).update(bytes).digest('hex');
const fail=code=>{throw Error('resource_publication_'+code);};
const team='team_uolDmrwvORBaI3V7q4JVMKNS';
const current=p=>p.targets?.production?.id??null;
function sourceFiles(tree){
 const root=tree.find(x=>x.name==='src');if(!root?.children)fail('source_manifest_missing');
 const files={};const walk=(nodes,prefix='')=>{for(const n of nodes){if(n.children)walk(n.children,prefix+n.name+'/');else files[prefix+n.name]=n.uid;}};walk(root.children);return files;
}
export function managedPublishing({call,repository,store,budget,request=fetch,token=()=>process.env.RESOURCE_VERCEL_TOKEN,now=Date.now}){
 const vercel=(path,options)=>call('vercel',path,options);
 const output=d=>({id:d.id??d.uid,url:'https://'+d.url,state:d.readyState??d.state});
 async function project(r){if(r.provider!=='vercel'||r.protected)fail('scope_invalid');const p=await vercel('/v9/projects/'+r.providerId);if(p.accountId!==team||p.id!==r.providerId)fail('owner_changed');return p;}
 async function deployment(r,id){if(!/^dpl_[A-Za-z0-9]+$/.test(id??''))fail('deployment_invalid');const d=await vercel('/v13/deployments/'+id);if(d.projectId!==r.providerId||!/^[-a-z0-9]+\.vercel\.app$/.test(d.url))fail('deployment_mismatch');return d;}
 async function find(r,actionId,sourceHash){
  const rows=(await vercel('/v6/deployments?projectId='+r.providerId+'&limit=100')).deployments;
  const found=rows.filter(d=>d.meta?.clausResourceAction===actionId&&d.meta?.clausSourceHash===sourceHash);if(found.length>1)fail('duplicate_deployment');return found.length?deployment(r,found[0].uid):null;
 }
 return {
  async prepare(r,repo,input){
   const p=await project(r);if(current(p)!==input.expectedDeploymentId)fail('production_changed');
   const source=await repository.repositoryTree(repo,input.commit);
   if(!source.files.length)fail('source_empty');
   const config=p.resourceConfig??{};if(config.buildMachineType!=='basic')fail('basic_build_machine_required');
   // Provider's Basic price is $0.007/minute, with a 45-minute maximum.
   // Reserve $0.50 including headroom; this is authorization, not a billed receipt.
   return {resource:r,repository:repo,source,sourceHash:sha(JSON.stringify(source)),prior:current(p),maximum:'500000',price:{machine:'basic',perMinuteMicroUsd:'7000',maximumMinutes:45,source:'https://vercel.com/changelog/basic-build-machines',observedAt:'2026-10-18'}};
  },
  async stage(prepared,actionId,dispatch){
   const r=prepared.resource,existing=await find(r,actionId,prepared.sourceHash);
   if(existing){await budget('commit',actionId,prepared.maximum);return {deployment:output(existing),sourceCommit:prepared.source.commit,sourceHash:prepared.sourceHash,priorDeploymentId:prepared.prior,buildCostAuthorizationMicroUsd:prepared.maximum,promoted:false};}
   const old=await store.get('transfer',actionId),files=[...(old?.files??[])],deadline=now()+45000;
   let index=files.length;
   for(;index<prepared.source.files.length&&now()<deadline;index++){
    const file=prepared.source.files[index],bytes=await repository.repositoryBlob(prepared.repository,file),hash=sha(bytes,'sha1');
    const response=await request('https://api.vercel.com/v2/files?teamId='+team,{method:'POST',headers:{authorization:'Bearer '+token(),'content-type':'application/octet-stream','content-length':String(bytes.length),'x-vercel-digest':hash},body:bytes,redirect:'error',signal:AbortSignal.timeout(30000)});
    await response.body?.cancel();if(!response.ok)fail('upload_'+response.status);
    files.push({file:file.path,sha:hash,size:bytes.length});
    const latest=await store.get('transfer',actionId),value={files,revision:(latest?.revision??0)+1};
    if(latest){if(latest.files.length>files.length)break;await store.change('transfer',actionId,latest.revision,value);}else await store.put('transfer',actionId,value);
   }
   const transferred=await store.get('transfer',actionId);
   if(!transferred||transferred.files.length!==prepared.source.files.length)return {pending:true,state:'uploading',uploadedFiles:transferred?.files.length??0,totalFiles:prepared.source.files.length,next:'Continue with the same originalRequestId, operation and input.'};
   const p=await project(r);if(current(p)!==prepared.prior)fail('production_changed');
   if(p.resourceConfig?.buildMachineType!=='basic')fail('build_machine_changed');
   await budget('reserve',actionId,prepared.maximum);
   let d;
   if(await dispatch()){
    try{d=await vercel('/v13/deployments?skipAutoDetectionConfirmation=1',{method:'POST',body:{name:r.name,project:r.providerId,target:'production',autoAssignCustomDomains:false,buildMachine:'basic',files:transferred.files,meta:{clausResourceAction:actionId,clausSourceHash:prepared.sourceHash,clausSourceCommit:prepared.source.commit},gitMetadata:{commitAuthorName:repositoryIdentity.name,commitAuthorEmail:repositoryIdentity.email,commitSha:prepared.source.commit,commitMessage:'Owned application publication'}}});}
    catch(e){if([400,401,402,403,404,413,422].includes(e.status)){await budget('cancel',actionId,prepared.maximum);return {state:'rejected',error:e.message,promoted:false,buildCostAuthorizationCancelled:true};}throw e;}
   }
   d=d?await deployment(r,d.id):await find(r,actionId,prepared.sourceHash);
   if(!d)return {pending:true,state:'outcome_unknown',retry:false,next:'Reconcile this originalRequestId; never create a replacement for an unknown build.'};
   await budget('commit',actionId,prepared.maximum);
   return {deployment:output(d),sourceCommit:prepared.source.commit,sourceHash:prepared.sourceHash,priorDeploymentId:prepared.prior,buildCostAuthorizationMicroUsd:prepared.maximum,promoted:false};
  },
  async promote(r,input,actionId,dispatch){
   const p=await project(r),d=await deployment(r,input.deploymentId);
   if(d.readyState!=='READY')fail('deployment_not_ready');
   const published=await store.get('publication',d.id);if(!published||published.resourceId!==r.id)fail('untracked_deployment');
   if(d.meta?.clausResourceAction!==published.actionId||d.meta?.clausSourceHash!==published.sourceHash)fail('source_identity_changed');
   const uploaded=await store.get('transfer',published.actionId);if(!uploaded)fail('source_manifest_missing');
   const actual=sourceFiles(await vercel('/v6/deployments/'+d.id+'/files')),expected=Object.fromEntries(uploaded.files.map(f=>[f.file,f.sha]));
   if(Object.keys(actual).length!==Object.keys(expected).length||Object.entries(expected).some(([path,hash])=>actual[path]!==hash))fail('source_manifest_changed');
   if(current(p)===d.id)return {deployment:output(d),promoted:true,codeRollbackRestoresData:false};
   if(current(p)!==input.expectedDeploymentId)fail('production_changed');
   if(typeof input.healthPath!=='string'||!/^\/[a-zA-Z0-9_./-]{0,150}$/.test(input.healthPath)||input.healthPath.startsWith('//'))fail('health_path_invalid');
   const bypass=Object.entries(p.protectionBypass??{}).find(([,v])=>v.scope==='automation-bypass')?.[0];
   const response=await request('https://'+d.url+input.healthPath,{headers:bypass?{'x-vercel-protection-bypass':bypass}:{},redirect:'error',signal:AbortSignal.timeout(15000)});await response.body?.cancel();if(!response.ok)fail('health_failed');
   if(await dispatch())await vercel('/v10/projects/'+r.providerId+'/promote/'+d.id,{method:'POST',body:{}});
   const observed=await project(r);if(current(observed)!==d.id)return {pending:true,state:'outcome_unknown',retry:false};
   await store.put('promotion',actionId,{resourceId:r.id,deploymentId:d.id,priorDeploymentId:input.expectedDeploymentId,healthPath:input.healthPath,at:new Date(now()).toISOString()});
   return {deployment:output(d),promoted:true,priorDeploymentId:input.expectedDeploymentId,codeRollbackRestoresData:false};
  }
 };
}
