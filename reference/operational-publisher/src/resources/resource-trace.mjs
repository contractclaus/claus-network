import {digest} from './store.mjs';
export const traceInputs={trace_action:['actionId','requestId','grantId']};
const fields=['id','actionId','originalRequestId','requestId','resourceId','workId','jobId','assignmentId','runId','sourceHash','responseSha256','status','state','phase','operation','kind','model','maximum','maximumMicroUsd','createdAt','updatedAt','at','observedAt','retryAt'];
const projection=v=>Object.fromEntries(fields.filter(k=>v?.[k]!==undefined&&v?.[k]!==null&&['string','number','boolean'].includes(typeof v[k])&&(typeof v[k]!=='string'||v[k].length<=240)).map(k=>[k,v[k]]));
export function resourceTrace({store}){return async input=>{
 if((input.actionId!==undefined)===(input.requestId!==undefined)||input.actionId!==undefined&&!/^act_[a-f0-9]{24}$/.test(input.actionId)||input.requestId!==undefined&&(typeof input.requestId!=='string'||!/^[a-zA-Z0-9:._-]{1,200}$/.test(input.requestId))||input.grantId!==undefined&&!/^sec_[a-f0-9]{24}$/.test(input.grantId))throw Error('resource_trace_input_invalid');
 const ids=input.actionId?[input.actionId]:[...new Set(['act_'+digest([input.grantId??'owner',input.requestId]).slice(0,24),...(!input.grantId?['act_'+digest(['model',input.requestId]).slice(0,24)]:[])])];
 const records=[];
 for(const id of ids){
  const [a,e,m,b]=await Promise.all([store.get('action',id),store.get('endpoint-response',id),store.get('model-response',id),store.get('build-run',id)]);if(!a)continue;
  const prepared=projection(a.prepared),output=projection(a.output),resource=a.prepared?.resource;
  const resourceRef=resource?.id?{id:resource.id,provider:resource.provider,kind:resource.kind,revision:resource.revision}:null;
  const links=[];for(const [field,value]of Object.entries({endpointActionId:a.prepared?.endpointActionId,resourceId:resource?.id??a.input?.resourceId,originalRequestId:a.prepared?.originalRequestId,queueId:a.input?.queueId,jobId:a.input?.jobId,workId:a.input?.workId})){if(typeof value==='string'&&value.length<=200)links.push({field,value});}
  const error=a.output?.error??a.output?.failure;records.push({actionId:id,operation:a.operation,phase:a.output?'completed':a.phase,prepared,output,resource:resourceRef,links,endpointReceipt:e?projection(e):null,modelReceipt:m?projection(m):null,build:b?projection(b):null,error:typeof error==='string'&&/^[a-z][a-z0-9_:-]{0,150}$/.test(error)?error:null});
 }
 return {found:records.length>0,records,lookedUp:ids,readOnly:true,holdsChanged:false,rawInputsAndOutputsReturned:false,meaning:'Original resource, endpoint, model and build identifiers with retained receipt metadata. A completed transport action does not prove application acceptance. Missing observations and unresolved outcomes remain unknown; use the original operation for reconciliation.'};
};}
