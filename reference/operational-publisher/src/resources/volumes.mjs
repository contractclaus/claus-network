import {digest,sameValue} from './store.mjs';
import {volumeProvider} from './volume-provider.mjs';
import {volumeFunding} from './volume-funding.mjs';
const fail=c=>{throw Error('resource_volume_'+c);};
const integer=(v,a,b)=>Number.isSafeInteger(v)&&v>=a&&v<=b;
const text=(v,n)=>typeof v==='string'&&v.trim().length>0&&v.length<=n;
const day=86400000;
export const volumeInputs={volume_catalog:[],volumes:['offset'],volume_info:['resourceId','cursor'],volume_create:['name','purpose','workId','projectId','sizeGb','region','fundedDays','autoRenew'],volume_renew:['resourceId','expectedRevision','fundedDays'],volume_resize:['resourceId','expectedRevision','sizeGb'],volume_delete:['resourceId','expectedRevision','disposition'],volume_cost:['resourceId']};
// Reserve the higher standard rate for all capacity, including above 1 TB.
// An authorization is deliberately distinct from a delayed provider invoice.
export const volumeMaximum=(sizeGb,milliseconds,monthlyRate)=>String((BigInt(sizeGb)*BigInt(monthlyRate)*BigInt(Math.ceil(milliseconds/day)+1)+29n)/30n);
const visible=r=>({id:r.id,name:r.name,kind:r.kind,provider:r.provider,providerId:r.providerId,projectId:r.projectId,workId:r.workId,sizeGb:r.sizeGb,region:r.region,status:r.status,revision:r.revision,fundedUntil:r.fundedUntil,autoRenew:r.autoRenew,fundedDays:r.fundedDays,createdAt:r.createdAt,pendingOperation:r.operation??null,maintenance:r.maintenance??null,backupPolicy:'A network volume survives deletion of its Pod. Export important files to verified owned R2 objects and retain an asset manifest. Volume deletion requires an explicit data disposition.',billing:'Storage continues while detached or while Pods are stopped; a fundedUntil timestamp is an internal reservation, not a provider TTL.'});
export function managedVolumes({store,budget,workStatus,provider=volumeProvider(),funding=volumeFunding(),now=Date.now}){
 const stamp=()=>new Date(now()).toISOString();
 const workActive=async id=>['ready','working','waiting'].includes(await workStatus(id));
 async function resource(id){if(!/^res_[a-f0-9]{24}$/.test(id??''))fail('reference_invalid');const r=await store.get('resource',id);if(!r||r.kind!=='managed-network-volume'||r.provider!=='runpod')fail('resource_invalid');return r;}
 async function update(r,fields){
  if(r.lastAction)await store.put('volume-outcome',r.lastAction,r);
  const value={...r,...fields,revision:r.revision+1,updatedAt:stamp()},saved=await store.change('resource',r.id,r.revision,value);
  if(fields.lastAction)await store.put('volume-outcome',fields.lastAction,saved);
  return saved;
 }
 function matches(v,r,size=r.sizeGb){if(!v||v.id!==r.providerId||v.name!==r.providerName||v.dataCenter!==r.region||v.type!=='STANDARD'||v.size!==size)fail('provider_changed');return v;}
 async function disposition(v){
  if(v?.kind==='discard'&&Object.keys(v).length===2&&text(v.reason,2000))return {...v,attestation:'Owner-selected disposal; not a backup proof'};
  if(v?.kind!=='backed-up'||Object.keys(v).length!==3||!text(v.name,100)||! /^[a-f0-9]{64}$/.test(v.version??''))fail('data_disposition_required');
  const a=await store.get('asset-version',v.name+':'+v.version),p=await store.get('asset-publication',v.name+':'+v.version);
  if(!a||!p||!a.files?.length)fail('backup_manifest_unavailable');
  for(const f of a.files){const o=await store.get('object',f.objectId);if(o?.resourceId!==f.resourceId||o.state!=='ready'||o.sha256!==f.sha256||o.bytes!==f.bytes||Date.parse(o.expiresAt)<=now())fail('backup_object_unavailable');}
  return {...v,files:a.files,attestation:'Owner selected this verified export as the retained data. Object integrity is verified; completeness relative to a live filesystem is not inferred.'};
 }
 async function call(operation,input,requestId){
  if(operation==='volume_catalog')return {...await provider.catalog(),price:await provider.pricing(),minimumGb:10,maximumGb:4096,mount:'One network volume per owned Runpod Pod, attached at creation in the same region',billing:'Storage remains chargeable until explicitly deleted. Pod deletion alone retains data.',backups:'Use an application worker to export files to owned R2; keep the verified asset version before stopping a training job.'};
  if(operation==='volumes'){const offset=input.offset??0;if(!integer(offset,0,Number.MAX_SAFE_INTEGER))fail('offset_invalid');const p=await store.list('resource',offset);return {...p,items:p.items.filter(r=>r.kind==='managed-network-volume').map(visible)};}
  if(operation==='volume_info'){
   const r=await resource(input.resourceId);return {resource:visible(r),provider:r.status==='removed'?null:await provider.read(r.providerId),attachments:r.status==='removed'?{items:[],nextCursor:null}:await provider.attachments(r.providerId,input.cursor),observedAt:stamp()};
  }
  if(operation==='volume_cost'){const r=await resource(input.resourceId);return provider.cost(r.providerId,r.createdAt);}
  if(!text(requestId,200))fail('request_invalid');
  const id='act_'+digest(['owner',requestId]).slice(0,24),existing=await store.get('action',id);
  if(existing&&(existing.operation!==operation||!sameValue(existing.input,input)))fail('request_conflict');
  if(existing?.output)return existing.output;
  let p=existing?.prepared;
  if(!p){
   if(operation==='volume_create'){
    if(!/^[a-z][a-z0-9-]{1,40}$/.test(input.name??'')||!text(input.purpose,350)||!/^nw_[a-z0-9_-]{1,80}$/.test(input.workId??'')||!/^prj_[A-Za-z0-9_-]{1,100}$/.test(input.projectId??'')||!integer(input.sizeGb,10,4096)||!integer(input.fundedDays,1,30)||typeof input.autoRenew!=='boolean'||!await workActive(input.workId))fail('definition_invalid');
    const catalog=await provider.catalog(),price=await provider.pricing();if(!catalog.regions.some(r=>r.id===input.region))fail('region_unavailable');
    const resourceId='res_'+digest(id).slice(0,24);
    p={id:resourceId,name:input.name,purpose:input.purpose,provider:'runpod',kind:'managed-network-volume',providerName:'claus-volume-'+id.slice(4),owner:'Claus',workId:input.workId,projectId:input.projectId,sizeGb:input.sizeGb,region:input.region,fundedDays:input.fundedDays,autoRenew:input.autoRenew,fundedUntil:new Date(now()+input.fundedDays*day).toISOString(),createdAt:stamp(),maximum:volumeMaximum(input.sizeGb,input.fundedDays*day,price.maximumMicroUsdPerGbMonth),price,creationAction:id};
   }else{
    const r=await resource(input.resourceId);if(r.status!=='active'||r.operation||input.expectedRevision!==r.revision)fail('revision_or_operation_conflict');
    if(operation==='volume_renew'){
     if(!integer(input.fundedDays,1,30)||!await workActive(r.workId))fail('renewal_invalid');
     const from=Math.max(now(),Date.parse(r.fundedUntil)),until=from+input.fundedDays*day;
     if(until>now()+31*day)fail('renewal_too_early');
     matches(await provider.read(r.providerId),r);const price=await provider.pricing();
     p={resource:r,fundedUntil:new Date(until).toISOString(),maximum:volumeMaximum(r.sizeGb,input.fundedDays*day,price.maximumMicroUsdPerGbMonth),price};
    }else if(operation==='volume_resize'){
     if(!integer(input.sizeGb,r.sizeGb+1,4096)||Date.parse(r.fundedUntil)<=now()||!await workActive(r.workId))fail('resize_invalid');
     const price=await provider.pricing();p={resource:r,sizeGb:input.sizeGb,maximum:volumeMaximum(input.sizeGb-r.sizeGb,Date.parse(r.fundedUntil)-now(),price.maximumMicroUsdPerGbMonth),price};
    }else if(operation==='volume_delete')p={resource:r,disposition:await disposition(input.disposition)};
    else fail('operation_invalid');
   }
   p=(await store.begin(id,operation,input,p)).row.result.prepared;
  }
  const reserveCost=async()=>{await budget('reserve',id,p.maximum,'volume');await funding('reserve',id,p);};
  const commitCost=async()=>{await funding('accept',id,p);await budget('commit',id,p.maximum,'volume');};
  const cancelCost=async()=>{await funding('cancel',id,p);await budget('cancel',id,p.maximum,'volume');};
  const complete=result=>store.complete(id,{id,...result});
  const pending=(state,more={})=>({id,pending:true,state,retry:false,originalRequestId:requestId,...more});
  const throttle=async e=>{if(e.status!==429)throw e;const retryAt=new Date(Math.max(now()+1000,e.retryAt??now()+30000)).toISOString();await store.deferRejected(id,retryAt);return pending('provider_rate_limited',{retryAt,next:'Continue this exact original request after retryAt. The provider explicitly rejected the prior attempt; its budget reservation is retained.'});};
  const action=await store.get('action',id);
  if(action.phase==='provider_retry'&&Date.parse(action.retryAt)>now())return pending('provider_rate_limited',{retryAt:action.retryAt,next:'Continue the original request after this time.'});
  if(operation==='volume_create'){
   let r=await store.get('resource',p.id);
   if(!r){
    await reserveCost();
    let found;
    const phase=(await store.get('action',id))?.phase;
    if(['prepared','provider_retry'].includes(phase)&&(Date.parse(p.fundedUntil)<=now()||!await workActive(p.workId))){await cancelCost();return complete({state:'rejected',error:'resource_volume_creation_authorization_expired',resourceCreated:false});}
    if(['prepared','provider_retry'].includes(phase)&&BigInt((await provider.pricing()).maximumMicroUsdPerGbMonth)>BigInt(p.price.maximumMicroUsdPerGbMonth)){await cancelCost();return complete({state:'rejected',error:'resource_volume_price_increased',resourceCreated:false});}
    if(await store.dispatch(id)){
     try{found=await provider.create({name:p.providerName,sizeGb:p.sizeGb,region:p.region});}
     catch(e){
      if([400,401,402,403,404,413,422].includes(e.status)){await cancelCost();return complete({state:'rejected',error:e.message,providerStatus:e.status,resourceCreated:false});}
      return throttle(e);
     }
    }else{
     const scan=await store.get('volume-scan',id),page=await provider.find(p.providerName,scan?.cursor??null);
     if(page.items.length>1)fail('duplicate_resource');found=page.items[0];
     if(!found){const next={cursor:page.nextCursor,revision:(scan?.revision??0)+1,at:stamp()};if(scan)await store.change('volume-scan',id,scan.revision,next);else await store.put('volume-scan',id,next);return pending('outcome_unknown',{nextCursor:page.nextCursor,next:'Reconcile the original request. An empty provider page is not permission to create another volume.'});}
    }
    if(found.name!==p.providerName||found.size!==p.sizeGb||found.dataCenter!==p.region||found.type!=='STANDARD')fail('provider_changed');
    r=(await store.put('resource',p.id,{...p,providerId:found.id,status:'active',revision:1})).value;
   }
   await commitCost();return complete({resource:visible(r),maximumCostMicroUsd:p.maximum,price:p.price});
  }
  let r=await resource(p.resource.id);
  const outcome=await store.get('volume-outcome',id)??(r.lastAction===id?r:null);
  if(outcome){if(p.maximum&&!outcome.operationResult?.rejected)await commitCost();return complete({resource:visible(outcome),dataDisposition:outcome.dataDisposition??null,maximumCostMicroUsd:p.maximum??null,...outcome.operationResult});}
  if(r.operation?.actionId!==id){
   if(r.revision!==p.resource.revision||r.operation)fail('revision_or_operation_conflict');
   r=await update(r,{operation:{actionId:id,kind:operation,originalRequestId:requestId},operationResult:null,...(operation==='volume_delete'?{status:'deleting'}:{})});
  }
  if(operation==='volume_renew'){
   await reserveCost();
   const inactive=!await workActive(r.workId)||Date.parse(p.fundedUntil)<=now(),priceHigher=BigInt((await provider.pricing()).maximumMicroUsdPerGbMonth)>BigInt(p.price.maximumMicroUsdPerGbMonth);
   if(inactive||priceHigher){await cancelCost();r=await update(r,{operation:null,lastAction:id,operationResult:{state:'rejected',rejected:true,error:inactive?'resource_volume_renewal_authorization_expired':'resource_volume_price_increased'}});return complete({resource:visible(r),...r.operationResult});}
   r=await update(r,{fundedUntil:p.fundedUntil,operation:null,lastAction:id,maintenance:null});await commitCost();return complete({resource:visible(r),maximumCostMicroUsd:p.maximum});
  }
  if(operation==='volume_resize'){
   await reserveCost();let actual=await provider.read(r.providerId);
   const reject=async error=>{await cancelCost();r=await update(r,{operation:null,lastAction:id,operationResult:{state:'rejected',rejected:true,error}});return complete({resource:visible(r),...r.operationResult});};
   if(actual?.size!==p.sizeGb){
    matches(actual,r);
    const phase=(await store.get('action',id))?.phase;
    if(['prepared','provider_retry'].includes(phase)){
     if(!await workActive(r.workId)||Date.parse(r.fundedUntil)<=now())return reject('resource_volume_resize_authorization_expired');
     if(BigInt((await provider.pricing()).maximumMicroUsdPerGbMonth)>BigInt(p.price.maximumMicroUsdPerGbMonth))return reject('resource_volume_price_increased');
    }
    if(await store.dispatch(id)){
     try{actual=await provider.resize(r.providerId,p.sizeGb);}
     catch(e){if([400,401,402,403,404,413,422].includes(e.status))return reject(e.message);return throttle(e);}
    }else return pending('resize_outcome_unknown');
   }
   matches(actual,r,p.sizeGb);await commitCost();r=await update(r,{sizeGb:p.sizeGb,operation:null,lastAction:id});return complete({resource:visible(r),maximumCostMicroUsd:p.maximum});
  }
  if(operation==='volume_delete'){
   const actual=await provider.read(r.providerId);
   if(actual){
    matches(actual,r);const scan=await store.get('volume-detach-scan',id),page=await provider.attachments(r.providerId,scan?.cursor??null);
    const next={cursor:page.items.length?null:page.nextCursor,revision:(scan?.revision??0)+1,at:stamp()};
    if(scan)await store.change('volume-detach-scan',id,scan.revision,next);else await store.put('volume-detach-scan',id,next);
    if(page.items.length)return pending('waiting_for_detach',{attachments:page.items,next:'Owned Pods lose access eligibility and are stopped by the existing guardian. Preserve/export data first. Other attached Pods must be detached by their owner.'});
    if(page.nextCursor)return pending('checking_attachments',{next:'Continue the same request; the provider inventory cursor is retained.'});
    const removed=await provider.remove(r.providerId);if(!removed.removed)return pending('delete_outcome_unknown');
   }
   r=await update(r,{status:'removed',removedAt:stamp(),operation:null,lastAction:id,dataDisposition:p.disposition});return complete({resource:visible(r),dataDisposition:p.disposition,historyRetained:true,providerStorageStopped:true,finalInvoiceVerified:false});
  }
 }
 async function tick(){
  let offset=0,processed=0,errors=0;
  do{const page=await store.list('resource',offset);offset=page.nextOffset;for(const r of page.items){if(r.kind!=='managed-network-volume'||r.status!=='active'||Date.parse(r.fundedUntil)>now()+6*3600000)continue;
   if(processed>=4)return {processed,errors,moreDue:true};processed++;
   try{
    if(r.autoRenew&&await workActive(r.workId)){
     if(r.operation&&r.operation.kind!=='volume_renew')continue;
     const requestId=r.operation?.originalRequestId??'volume-auto-renew:'+r.id+':'+r.fundedUntil+':'+r.revision,actionId='act_'+digest(['owner',requestId]).slice(0,24),prior=await store.get('action',actionId);
     await call('volume_renew',prior?.input??{resourceId:r.id,expectedRevision:r.revision,fundedDays:r.fundedDays},requestId);
    }else if(!r.maintenance)await update(r,{maintenance:{state:'retention_needs_action',at:stamp(),next:'Export required data and delete this volume, or renew it under active work. Detached storage remains chargeable; this timestamp is not a provider expiry.'}});
   }catch{errors++;}
  }}while(offset!==null);
  return {processed,errors};
 }
 return {call,tick};
}
