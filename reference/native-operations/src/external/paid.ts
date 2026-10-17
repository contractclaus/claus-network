import {createHash} from 'node:crypto';
import {ProviderFailure} from './providers.js';
const origin='https://claus-ecosystem-payments.vercel.app';
export const paidServiceIdentity=(actionId:string)=>'external-service:'+createHash('sha256').update(actionId).digest('hex');
export async function paidServiceRequest(operation:string,input:any,actionId:string){
 const key=process.env.INFERENCE_SECRET;if(!key)throw new ProviderFailure('paid_service_not_connected',true);
 const id=paidServiceIdentity(actionId);
 let body:any;
 if(operation==='quote')body={operation:'quote',input};
 else if(operation==='call')body={operation:'call',id,input};
 else if(operation==='read'){
  if(input.actionId!==undefined){if(typeof input.actionId!=='string'||!/^external:[a-zA-Z0-9:_-]{1,200}$/.test(input.actionId))throw new ProviderFailure('paid_service_id_invalid',true);input={...input,id:paidServiceIdentity(input.actionId)};}
  if(!/^external-service:[a-f0-9]{64}$/.test(input.id??''))throw new ProviderFailure('paid_service_id_invalid',true);
  body={operation:'status',id:input.id};
 }else if(operation!=='describe')throw new ProviderFailure('paid_service_operation_invalid',true);
 const response=await fetch(origin+'/api/external-services',{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(operation==='call'?85000:25000),headers:{authorization:'Bearer '+key,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const text=await response.text();if(Buffer.byteLength(text)>400000)throw new ProviderFailure('paid_service_response_size',operation!=='call');
 const result=JSON.parse(text);
 if(!response.ok)throw new ProviderFailure(/^external_service_[a-z_]+$/.test(result.error)?result.error:'paid_service_unavailable',operation!=='call'||[401,403,413].includes(response.status)||['external_service_input_invalid','external_service_url_invalid','external_service_id_invalid','external_service_operation_invalid'].includes(result.error));
 return {paymentId:operation==='read'?input.id:operation==='call'?id:null,...result};
}
