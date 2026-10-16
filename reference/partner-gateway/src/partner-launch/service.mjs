import {createHash} from 'node:crypto';
import {canonical,digest} from '../capital/policy.mjs';
import {inspectClausPartnerProfile} from './profile.mjs';

const ORIGIN='https://api.programmable.market',NETWORK='https://claus-network-api.vercel.app';
const HASH=/^sha256:[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const check=(v,c)=>{if(!v)throw Error('partner_gateway_'+c);};
const controlled=new Set(['0x59edf6152080e847e5ea15f9ae6a77c1f03c44f5','0xbb145ca83272c3806d4ddc75ca1d5514789cf1c5','0xa46a89b5b3504c1c999696de8173ec9b2eb0a01a', '0x40411c03f0e0160a09dde6d75f1b1cf36aed651f', '0xdfc3173d14a482be0e5caac0af52154783556ba7', '0x892fa49d0c38e949deb827db66590fbaeaa34af8']);
function requestCanonical(v,depth=0){
 check(depth<=32,'request_depth');if(v===null||typeof v==='boolean'||typeof v==='string')return JSON.stringify(v);
 if(typeof v==='number'){check(Number.isFinite(v),'request_number');return JSON.stringify(v);}
 if(Array.isArray(v))return '['+v.map(x=>requestCanonical(x,depth+1)).join(',')+']';
 check(v&&Object.getPrototypeOf(v)===Object.prototype&&!Object.keys(v).some(k=>['__proto__','constructor','prototype'].includes(k)),'request_json');
 return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+requestCanonical(v[k],depth+1)).join(',')+'}';
}
const requestHash=v=>'sha256:'+createHash('sha256').update('programmable.custom-launch-create-request.v3').update(Buffer.from([0])).update(requestCanonical(v)).digest('hex');
async function readJson(response,maximum=3200000,secret){
 check(response.body,'empty_response');const reader=response.body.getReader(),chunks=[];let bytes=0;
 try{for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>maximum){await reader.cancel();throw Error('partner_gateway_response_too_large');}chunks.push(r.value);}}finally{reader.releaseLock();}
 const raw=Buffer.concat(chunks).toString('utf8'),safe=secret?raw.split(secret).join('[redacted]'):raw;
 check(/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''),'non_json_response');return JSON.parse(safe);
}
export function createPartnerGateway({network,repository,pins,key,request=fetch,now=Date.now}){
 const assignment=typeof pins==='string'?JSON.parse(pins):pins;
 async function provider(path,method='GET',body,idempotencyKey){
  const secret=key();check(typeof secret==='string'&&secret.length>=20,'not_configured');
  let response;
  try{response=await request(ORIGIN+path,{method,redirect:'error',signal:AbortSignal.timeout(25000),headers:{accept:'application/json',authorization:'Bearer '+secret,...(body?{'content-type':'application/json'}:{}),...(idempotencyKey?{'idempotency-key':idempotencyKey}:{})},...(body?{body:JSON.stringify(body)}:{})});}
  catch{throw Error('partner_gateway_provider_outcome_unknown');}
  const data=await readJson(response,2500000,secret);
  if(response.status>=500||response.status===429)throw Error('partner_gateway_provider_outcome_unknown');
  return {httpStatus:response.status,requestId:response.headers.get('x-request-id'),data,ok:response.ok};
 }
 async function profile(){
  if(!key()||!assignment)return {state:'unavailable',reason:'partner_not_configured',launchAuthorized:false,walletSigned:false};
  const result=await provider('/v1/partner/launch-profile');
  if(!result.ok)return {state:'unavailable',reason:'provider_profile_unavailable',httpStatus:result.httpStatus,launchAuthorized:false,walletSigned:false};
  return inspectClausPartnerProfile(result.data,assignment,now());
 }
 async function sourceRequest(context,sourceHash){
  check(context.assignmentHash===digest(assignment)&&['partnerId','kernelSourceHash','policyOwner','policyExecutor'].every(k=>context[k]===assignment[k]),'draft_assignment_changed');
  const source=await network.call('public_source',{sourceId:digest({projectId:context.projectId,id:sourceHash})});
  check(source.projectId===context.projectId&&source.snapshotId===sourceHash&&Array.isArray(source.files),'source_changed');
  const files=source.files.filter(f=>f.path===context.requestFile);check(files.length===1,'request_file_missing');
  const file=files[0];check(digest({path:file.path,content:file.content})===file.hash,'request_file_changed');
  const body=JSON.parse(file.content);check(body.schemaVersion==='programmable.custom-launch-create-request.v3'&&body.chainId==='1'&&
   body.launchWallet.toLowerCase()===context.ownerAddress&&requestHash(body)===context.requestHash,'request_changed');
  return body;
 }
 async function proof(receiptId){
  check(HASH.test(receiptId),'receipt_id');check((await profile()).state==='profile_ready','profile_not_ready');
  const response=await request(NETWORK+'/v1/public/partner-launches/'+encodeURIComponent(receiptId),{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(25000),headers:{accept:'application/json'}});
  check(response.ok,'receipt_unavailable');const receipt=await readJson(response,32768);
  check(receipt.schemaVersion==='claus.partner-launch-admission.v1'&&receipt.receiptId===receiptId&&receipt.decision==='approved'&&
   receipt.profileId==='programmable.claus-quote.v1'&&receipt.chainId===1&&receipt.assignmentHash===digest(assignment)&&
   ['partnerId','kernelSourceHash','policyOwner','policyExecutor'].every(k=>receipt[k]===assignment[k])&&
   receipt.launchWallet===receipt.ownerAddress&&/^0x[a-f0-9]{40}$/.test(receipt.ownerAddress)&&
   !controlled.has(receipt.ownerAddress)&&![assignment.policyOwner,assignment.policyExecutor].includes(receipt.ownerAddress)&&
   receipt.creatorFeeRecipient===receipt.ownerAddress&&Number.isSafeInteger(receipt.approvedAt)&&receipt.approvedAt<=now()&&
   receipt.approvedAt>=Date.parse(assignment.activeAfter)&&Number.isSafeInteger(receipt.expiresAt)&&receipt.expiresAt>now()&&
   receipt.expiresAt-receipt.approvedAt<=3600000,'receipt_mismatch');
  check(receipt.receiptId===digest({schemaVersion:receipt.schemaVersion,projectId:receipt.projectId,caseId:receipt.review?.caseId,contextHash:receipt.contextHash,expiresAt:receipt.expiresAt}),'receipt_hash');
  const evidence=await network.call('partner_launch_evidence',{projectId:receipt.projectId,caseId:receipt.review.caseId});
  check(digest(evidence.context)===receipt.contextHash&&digest(evidence.review)===digest(receipt.review),'review_changed');
  const body=await sourceRequest(evidence.context,receipt.review.sourceHash);
  return {receipt,context:evidence.context,body};
 }
 const operationId=(stage,effect)=>'partner-'+stage+':'+digest(effect).slice(7);
 const creation=(context,caseId)=>({projectId:context.projectId,caseId,contextHash:digest(context),requestHash:context.requestHash});
 async function perform(stage,effect,work){
  const id=operationId(stage,effect),record=await repository.reserve(id,'partner-gateway',effect);
  if(!record.created)return {operationId:id,state:record.row.status,result:record.row.result??null,walletSigned:false,transactionBroadcast:false};
  try{const result=await work(id);await repository.save(id,result.ok?'completed':'rejected',result);
   return {operationId:id,state:result.ok?'completed':'rejected',result,walletSigned:false,transactionBroadcast:false};}
  catch(e){await repository.save(id,'outcome_unknown',{error:'partner_gateway_outcome_unknown'});return {operationId:id,state:'outcome_unknown',next:'Read this original operation. Do not replace it with a new receipt or request.',walletSigned:false,transactionBroadcast:false};}
 }
 async function original(id){check(/^partner-(create|admit):[a-f0-9]{64}$/.test(id),'operation_id');const row=await repository.get(id);check(row?.kind==='partner-gateway','operation_missing');return row;}
 return {
  profile,
  async stage({projectId,caseId}){
   check((await profile()).state==='profile_ready','profile_not_ready');
   const draft=await network.call('partner_launch_prepare',{projectId,caseId});
   check(draft.approval===false&&draft.stage==='pending-independent-review'&&draft.caseId===caseId&&draft.context.projectId===projectId,'draft_mismatch');
   const body=await sourceRequest(draft.context,draft.sourceHash);
   return perform('create',creation(draft.context,caseId),id=>provider('/v3/custom-launches','POST',body,id));
  },
  async preflight({receiptId}){const p=await proof(receiptId);const result=await provider('/v3/custom-launches/preflight','POST',p.body);return {...result,walletSigned:false,transactionBroadcast:false};},
  async submit({receiptId}){const p=await proof(receiptId);return perform('create',creation(p.context,p.receipt.review.caseId),id=>provider('/v3/custom-launches','POST',p.body,id));},
  async admit({operationId:id,receiptId}){
   const row=await original(id);check(id.startsWith('partner-create:')&&row.status==='completed','creation_incomplete');
   const launchId=row.result?.data?.launchId;check(UUID.test(launchId),'provider_launch_id');const p=await proof(receiptId);
   check(p.receipt.requestHash===row.input.requestHash&&p.receipt.contextHash===row.input.contextHash&&p.receipt.projectId===row.input.projectId&&p.receipt.review.caseId===row.input.caseId,'original_request_changed');
   return perform('admit',{receiptId:p.receipt.receiptId,requestHash:p.receipt.requestHash,launchId},key=>provider('/v1/partner/launch-admissions','POST',{schemaVersion:'programmable.claus-launch-admission-request.v1',launchId,receiptId:p.receipt.receiptId},key));
  },
  async status({operationId:id}){const row=await original(id),launchId=row.result?.data?.launchId??row.input.launchId;
   const resource=UUID.test(launchId)?await provider('/v3/custom-launches/'+launchId):null;
   return {operationId:id,state:row.status,result:row.result??null,resource,walletSigned:false,transactionBroadcast:false};}
 };
}
