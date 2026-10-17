import {createHash} from 'node:crypto';
import {programDigest} from './program-run.mjs';
export const receiptRoute={name:'app_request_receipt',method:'GET',path:'/v1/apps/{projectId}/request-receipt',inputSchema:{type:'object',properties:{projectId:{type:'string',minLength:1,maxLength:256},operation:{type:'string',minLength:1,maxLength:64},idempotencyKey:{type:'string',minLength:1,maxLength:128},requestHash:{type:'string',minLength:71,maxLength:71}},required:['projectId','operation','idempotencyKey','requestHash'],additionalProperties:false}};
export function appReceiptInput(operation,input){
 let op,body;
 if(operation==='app_configure'){op='configure';body={manifest:input.manifest,expectedRevision:input.expectedRevision};}
 else if(operation==='app_publish'){op=input.published?'publish':'withdraw';body={published:input.published,expectedRevision:input.expectedRevision};}
 else if(['app_record_create','app_record_update'].includes(operation)){op='record:'+input.collection;body={recordId:input.recordId??null,data:input.data,parentId:input.parentId??null,expectedRevision:input.expectedRevision??0};}
 else if(operation==='app_service_call'){op='service:'+input.serviceId;body={request:input.request,expectedRevision:input.expectedRevision,expectedSourceHash:input.expectedSourceHash};}
 else throw Error('network_program_receipt_operation_denied');
 return {projectId:input.projectId,operation:op,idempotencyKey:input.idempotencyKey,requestHash:'sha256:'+programDigest(body)};
}
// Missing records, transport failures and changed bindings never authorize a
// new send. Recovery is read-only even when current work/source was revoked.
export async function readOriginalAppResult(call,operation,input){
 if(operation==='data_file_write'){
  const fileId='sha256:'+programDigest({projectId:input.projectId,upload:input.idempotencyKey});
  const file=await call('data_file_get',{projectId:input.projectId,fileId});
  const bytes=Buffer.from(input.content,input.encoding==='base64'?'base64':'utf8'),sha256='sha256:'+createHash('sha256').update(bytes).digest('hex');
  if(file.id!==fileId||file.projectId!==input.projectId||file.name!==input.name||file.bytes!==bytes.length||file.sha256!==sha256||file.state!=='ready')throw Error('network_program_original_receipt_unavailable');
  return file;
 }
 const query=appReceiptInput(operation,input),receipt=await call('app_request_receipt',query);
 if(receipt?.profile!=='claus-app-request-receipt/1'||Object.entries(query).some(([k,v])=>receipt[k]!==v))throw Error('network_program_receipt_binding');
 if(receipt.state!=='completed'||!Object.hasOwn(receipt,'result'))throw Error('network_program_original_receipt_unavailable');
 return receipt.result;
}
