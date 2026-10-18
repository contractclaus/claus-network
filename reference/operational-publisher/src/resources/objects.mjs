import {createSHA256} from 'hash-wasm';
import {digest,sameValue} from './store.mjs';
import {objectProvider} from './object-provider.mjs';
const fail=c=>{throw Error('resource_storage_'+c);};
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
export const objectInputs={bucket_create:['name','purpose','retentionDays'],bucket_remove:['resourceId'],object_prepare:['resourceId','name','sha256','bytes','partBytes'],object_get:['resourceId','objectId'],object_list:['resourceId','offset'],object_upload:['resourceId','objectId','partNumber'],object_parts:['resourceId','objectId','afterPart'],object_commit:['resourceId','objectId'],object_download:['resourceId','objectId'],object_remove:['resourceId','objectId']};
const visible=v=>({id:v.id,resourceId:v.resourceId,name:v.name,bytes:v.bytes,sha256:v.sha256,partBytes:v.partBytes,partCount:v.partCount,state:v.state,verifiedBytes:v.verifiedBytes??0,createdAt:v.createdAt,uploadDeadline:v.uploadDeadline,expiresAt:v.expiresAt??null,verifiedAt:v.verifiedAt??null,removedAt:v.removedAt??null,maximumCostMicroUsd:v.maximum,revision:v.revision});
export function managedObjects({store,budget,seal,open,provider=objectProvider(),now=Date.now,verificationChunkBytes=8*1024*1024}){
 const stamp=()=>new Date(now()).toISOString();
 async function resource(id){const r=await store.get('resource',id);if(!r||r.provider!=='r2'||r.status==='removed')fail('resource_invalid');return r;}
 async function object(input){const r=await resource(input.resourceId);if(!/^obj_[a-f0-9]{24}$/.test(input.objectId??''))fail('reference_invalid');const o=await store.get('object',input.objectId);if(!o||o.resourceId!==r.id)fail('reference_invalid');return {r,o};}
 async function update(o,fields){const value={...o,...fields,revision:o.revision+1};await store.change('object',o.id,o.revision,value);return value;}
 const uploadable=o=>{if(o.state!=='uploading'||Date.parse(o.uploadDeadline)<=now())fail('upload_expired');};
 async function begin(operation,input,requestId,principal,prepare){
  if(typeof requestId!=='string'||!requestId||requestId.length>200)fail('request_invalid');
  const id='act_'+digest([principal,requestId]).slice(0,24),old=await store.get('action',id);
  if(old&&(old.operation!==operation||!sameValue(old.input,input)))fail('request_conflict');
  if(old)return {id,row:old};const prepared=await prepare(id);return {id,row:(await store.begin(id,operation,input,prepared)).row.result};
 }
 return {
  configured:provider.configured,
  async inspect(r){return {...await provider.bucket(r.providerId),retentionDays:r.retentionDays,status:r.status??'active'};},
  async call(operation,input,requestId,principal='owner'){
   if(operation==='object_list'){await resource(input.resourceId);const offset=input.offset??0;if(!integer(offset,0,Number.MAX_SAFE_INTEGER))fail('offset_invalid');const p=await store.list('object',offset);return {...p,items:p.items.filter(o=>o.resourceId===input.resourceId).map(visible)};}
   if(['object_get','object_parts','object_upload','object_download'].includes(operation)){
    const {r,o}=await object(input);
    if(operation==='object_get')return {object:visible(o)};
    if(operation==='object_download'){if(o.state!=='ready'||Date.parse(o.expiresAt)<=now())fail('not_ready');return {object:visible(o),download:await provider.download(r.providerId,o.key,o.etag)};}
    uploadable(o);
    if(operation==='object_parts'){const after=input.afterPart??0;if(!integer(after,0,o.partCount))fail('part_invalid');return {object:visible(o),...await provider.parts(r.providerId,o.key,o.uploadId,after)};}
    const number=input.partNumber;if(!integer(number,1,o.partCount))fail('part_invalid');const bytes=Math.min(o.partBytes,o.bytes-(number-1)*o.partBytes);
    return {object:visible(o),partNumber:number,offset:(number-1)*o.partBytes,bytes,upload:await provider.upload(r.providerId,o.key,o.uploadId,number,bytes)};
   }
   const action=await begin(operation,input,requestId,principal,async id=>{
    if(operation==='bucket_create'){
     if(typeof input.name!=='string'||! /^[a-z][a-z0-9-]{1,40}$/.test(input.name)||typeof input.purpose!=='string'||!input.purpose.trim()||input.purpose.length>350||!integer(input.retentionDays,1,365))fail('bucket_input_invalid');
     return {id:'res_'+digest(id).slice(0,24),name:input.name,purpose:input.purpose,provider:'r2',providerId:'claus-owned-'+digest(id).slice(0,24),owner:'Claus',kind:'managed-object-bucket',retentionDays:input.retentionDays,createdAt:stamp(),revision:1,creationAction:id};
    }
    if(operation==='object_prepare'){
     const r=await resource(input.resourceId);if(typeof input.name!=='string'||!input.name||input.name.length>240||input.name.includes('\0')||! /^[a-f0-9]{64}$/.test(input.sha256??'')||!integer(input.bytes,1,5*1024**4))fail('object_input_invalid');
     const partBytes=input.partBytes??Math.max(64*1024**2,Math.ceil(input.bytes/10000/1024**2)*1024**2);if(!integer(partBytes,5*1024**2,5*1024**3)||Math.ceil(input.bytes/partBytes)>10000)fail('part_size_invalid');
     const count=Math.ceil(input.bytes/partBytes),storage=(BigInt(input.bytes)*15000n*BigInt(r.retentionDays+3)+30000000000n-1n)/30000000000n;
     const processing=(BigInt(input.bytes)*5000n+999999999n)/1000000000n,maximum=String(storage+processing+BigInt(count)*40n+25000n);if(BigInt(maximum)>200000000n)fail('budget_maximum_exceeded');
     const objectId='obj_'+digest(id).slice(0,24);return {id:objectId,resourceId:r.id,key:'objects/'+objectId,name:input.name,bytes:input.bytes,sha256:input.sha256,partBytes,partCount:count,maximum,retentionDays:r.retentionDays,revision:1,state:'uploading',createdAt:stamp(),uploadDeadline:new Date(now()+86400000).toISOString(),creationAction:id};
    }
    if(operation==='bucket_remove')return {resource:await resource(input.resourceId)};
    if(operation==='object_commit'||operation==='object_remove'){const {o}=await object(input);return {objectId:o.id,resourceId:o.resourceId};}
    fail('operation_invalid');
   });
   const {id,row}=action;if(row.output)return row.output;
   const p=row.prepared,complete=value=>store.complete(id,{id,...value});
   if(operation==='bucket_create'){
    let found;try{found=await provider.bucket(p.providerId);}catch(e){if(e.status!==404)throw e;}
    if(!found&&await store.dispatch(id)){await provider.createBucket(p.providerId);found={name:p.providerId,rules:[]};}
    if(!found)return {id,state:'outcome_unknown',retry:false};
    if(!found.rules?.length)await provider.lifecycle(p.providerId,p.retentionDays);
    found=await provider.bucket(p.providerId);const rule=found?.rules?.find(r=>r.ID==='claus-owned-retention');
    if(found?.rules?.length!==1||rule?.Status!=='Enabled'||rule?.Filter?.Prefix!=='objects/'||rule?.Expiration?.Days!==p.retentionDays||rule?.AbortIncompleteMultipartUpload?.DaysAfterInitiation!==1)fail('lifecycle_mismatch');
    const saved=await store.put('resource',p.id,p);return complete({resource:saved.value,private:true,billing:'Storage is authorized when an object is prepared; quotes include its entire retention period. Incomplete multipart uploads expire after one day.'});
   }
   if(operation==='object_prepare'){
    const r=await resource(p.resourceId);let stored=await store.get('object',p.id);
    if(!stored){
     await budget('reserve',id,p.maximum,'storage');let uploadId=await provider.uploads(r.providerId,p.key);
     if(!uploadId&&await store.dispatch(id))uploadId=await provider.begin(r.providerId,p.key,{'claus-object-id':p.id,'claus-sha256':p.sha256});
     if(!uploadId)return {id,state:'outcome_unknown',retry:false,next:'Keep the original requestId. Do not start a replacement upload.'};
     stored=(await store.put('object',p.id,{...p,uploadId})).value;
    }
    await budget('commit',id,p.maximum,'storage');return complete({object:visible(stored),pricing:{storageMicroUsdPerGbMonth:'15000',egressMicroUsd:'0',basis:'https://developers.cloudflare.com/r2/pricing/',observedAt:'2026-10-18',type:'maximum authorization, not invoice'},next:'Use object_upload for each part and object_parts to reconcile an interrupted transfer. object_commit resumes verification using its original requestId.'});
   }
   if(operation==='object_commit'){
    const {r}=await object(input);let o=(await object(input)).o;if(o.state==='ready')return complete({object:visible(o)});if(!['uploading','verifying'].includes(o.state))fail('commit_state_invalid');
    let head=await provider.head(r.providerId,o.key);
    if(!head){
     uploadable(o);const parts=[];let marker=0;do{const page=await provider.parts(r.providerId,o.key,o.uploadId,marker);if(!page)fail('upload_outcome_unknown');parts.push(...page.items);marker=page.next;}while(marker!==null);
     if(parts.length!==o.partCount||parts.some((part,i)=>part.number!==i+1||part.bytes!==Math.min(o.partBytes,o.bytes-i*o.partBytes)))fail('parts_incomplete');
     if(await store.dispatch(id))await provider.complete(r.providerId,o.key,o.uploadId,parts);
     head=await provider.head(r.providerId,o.key);if(!head)return {id,state:'outcome_unknown',retry:false};
    }
    if(head.bytes!==o.bytes||head.metadata?.['claus-object-id']!==o.id||head.metadata?.['claus-sha256']!==o.sha256)fail('object_mismatch');
    if(o.state==='uploading')o=await update(o,{state:'verifying',etag:head.etag,expiresAt:new Date(Date.parse(head.modifiedAt)+o.retentionDays*86400000).toISOString(),verifiedBytes:0});
    if(o.etag!==head.etag)fail('object_changed');
    const hasher=await createSHA256();if(o.hashState)hasher.load(Buffer.from(open(o.hashState,o.id+':'+o.verifiedBytes),'base64'));
    const deadline=now()+45000;
    while(o.verifiedBytes<o.bytes&&now()<deadline){
     const start=o.verifiedBytes,end=Math.min(o.bytes,start+verificationChunkBytes)-1,signal=AbortSignal.timeout(30000);const block=await provider.range(r.providerId,o.key,o.etag,start,end,signal);let read=0;
     const abort=()=>block.Body?.destroy?.();signal.addEventListener('abort',abort,{once:true});
     try{for await(const chunk of block.Body){signal.throwIfAborted();read+=chunk.length;if(read>end-start+1)fail('range_size');hasher.update(chunk);}signal.throwIfAborted();if(read!==end-start+1)fail('range_size');}finally{signal.removeEventListener('abort',abort);block.Body?.destroy?.();}
     const offset=end+1;o=await update(o,{verifiedBytes:offset,hashState:seal(Buffer.from(hasher.save()).toString('base64'),o.id+':'+offset)});
    }
    if(o.verifiedBytes<o.bytes)return {id,pending:true,object:visible(o),next:'Continue the same object_commit requestId and input; verified bytes and the encrypted SHA256 state are retained.'};
    const sha=hasher.digest('hex');if(sha!==o.sha256){o=await update(o,{state:'corrupt',hashState:null,observedSha256:sha});return complete({object:visible(o),error:'resource_storage_integrity_failed'});}
    o=await update(o,{state:'ready',hashState:null,verifiedAt:stamp()});return complete({object:visible(o),integrity:'full-object-sha256'});
   }
   if(operation==='object_remove'){
    const {r,o}=await object(input);if(o.state==='removed')return complete({object:visible(o),removed:true});const result=await provider.remove(r.providerId,o.key,o.uploadId);if(!result.removed)fail('delete_unknown');const removed=await update(o,{state:'removed',hashState:null,removedAt:stamp()});return complete({object:visible(removed),removed:true,historyRetained:true});
   }
   if(operation==='bucket_remove'){
    const r=p.resource;const result=await provider.removeBucket(r.providerId);if(!result.removed)fail('delete_unknown');const current=await store.get('resource',r.id);if(current.status!=='removed')await store.change('resource',r.id,current.revision,{...current,status:'removed',removedAt:stamp(),revision:current.revision+1});return complete({resourceId:r.id,removed:true,historyRetained:true});
   }
  }
 };
}
