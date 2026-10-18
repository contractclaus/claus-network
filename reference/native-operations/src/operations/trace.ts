import {diagnose} from './diagnosis.ts';
import {readPaymentTrace} from './payment-trace-client.ts';
import {sql} from '../store.js';

const referenceNames=new Set(['id','actionId','originalRequestId','requestId','workId','parentId','resourceId','queueId','jobId','assignmentId','buildId','reviewEffect','responseId','deploymentId','sourceHash','transactionHash','hash']);
const containers=new Set(['result','receipt','output','deployment','proof','review','accounting','responseProof','outcome','progress','inferenceFailure']);
const reference=(value:any)=>typeof value==='string'&&value.length<=200&&/^(?:j_\d+|(?:nw|act|op|res|job|asg|build|eff)_[a-zA-Z0-9_-]+|dpl_[a-zA-Z0-9]+|sha256:[a-f0-9]{64}|0x[a-f0-9]{64}|[a-f0-9]{40}|[a-f0-9-]{36}(?::[a-zA-Z0-9:_-]+)?|(?:network-review|model-route|external):[a-zA-Z0-9:_-]+)$/.test(value);
const code=(v:any)=>typeof v==='string'&&/^[a-z][a-z0-9_:-]{0,150}$/.test(v)?v:null;
export function traceProjection(value:any){
 const references:any[]=[],diagnostics:any[]=[];
 function walk(v:any,path:string,depth:number){
  if(!v||typeof v!=='object'||Array.isArray(v)||depth>5)return;
  for(const [key,item] of Object.entries(v)){
   const field=path?path+'.'+key:key;
   if(referenceNames.has(key)&&reference(item))references.push({field,value:item});
   if(containers.has(key))walk(item,field,depth+1);
  }
  const error=code(v.error??v.failure??v.providerCode),httpStatus=Number.isInteger(v.httpStatus)?v.httpStatus:null;
  if(error||httpStatus)diagnostics.push({field:path,...diagnose({error,httpStatus,state:v.state??v.status}),meaning:'A specific retained code identifies the failing boundary. A bare HTTP status does not establish a deeper internal cause.'});
 }
 walk(value,'',0);return {references:references.slice(0,80),diagnostics:diagnostics.slice(0,40),projectionOnly:true};
}

export async function traceNative(input:any,query:any=(statement:string,values:any[])=>sql().query(statement,values)){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['kind','id'].includes(k))||typeof input.id!=='string'||input.id.length>200)return {error:'operation_trace_input_invalid'};
 if(input.kind==='payment')return readPaymentTrace(input.id,{secret:process.env.INFERENCE_SECRET,base:process.env.INFERENCE_URL});
 let rows:any[],metadata:any;
 if(input.kind==='work'&&/^nw_[a-z0-9_-]{1,80}$/.test(input.id)){
  rows=await query('SELECT id,status,result_stage,parent_id,dependencies,evidence,updated_at FROM claus_network_work WHERE id=$1',[input.id]);
  if(!rows.length)return {found:false,kind:input.kind,id:input.id};const r=rows[0];
  return {found:true,kind:input.kind,id:r.id,status:r.status,resultStage:r.result_stage,updatedAt:r.updated_at,parents:[r.parent_id,...(r.dependencies??[])].filter(Boolean).map(id=>({kind:'work',id})),evidence:(r.evidence??[]).filter((id:any)=>/^j_\d+$/.test(id)).map((id:any)=>({kind:'journal',id})),readOnly:true,meaning:'Stored work links, not an independent completion or acceptance judgment.'};
 }
 if(input.kind==='journal'&&/^j_[1-9]\d{0,15}$/.test(input.id)){
  rows=await query("SELECT id,kind,summary,data->'result' AS result,data->>'success' AS success,created_at FROM claus_journal WHERE id=$1",[input.id.slice(2)]);
  if(rows.length){const r=rows[0];metadata={id:input.id,kind:input.kind,journalKind:r.kind,tool:r.kind==='tool'?code(r.summary):null,success:r.success==='true'?true:r.success==='false'?false:null,createdAt:r.created_at,...traceProjection(r.result)};}
 }else if(input.kind==='action'&&/^[a-zA-Z0-9:_-]{1,200}$/.test(input.id)){
  rows=await query("SELECT id,kind,status,input_hash,result,progress->'inferenceFailure' AS inference_failure,created_at,completed_at FROM claus_actions WHERE id=$1",[input.id]);
  if(rows.length){const r=rows[0],d=r.inference_failure;metadata={id:r.id,kind:input.kind,actionKind:r.kind,status:r.status,inputHash:r.input_hash,createdAt:r.created_at,completedAt:r.completed_at,originalPaymentRequest:r.kind==='inference'||r.kind==='image'?r.id:null,payment:r.kind==='inference'||r.kind==='image'?await readPaymentTrace(r.id,{secret:process.env.INFERENCE_SECRET,base:process.env.INFERENCE_URL}):null,...traceProjection(r.result),transport:d?{channel:d.channel,phase:d.phase,elapsedMs:d.elapsedMs,timeoutMs:d.timeoutMs,httpStatus:d.httpStatus,errorType:code(d.errorType),transportCode:code(d.transportCode),callerDeadlineReached:d.callerDeadlineReached===true}:null};}
 }else if(input.kind==='release'&&/^op_[a-f0-9]{24}$/.test(input.id)){
  rows=await query('SELECT id,scope,state,source_hash,base_deployment,deployment,proof FROM claus_operations_releases WHERE id=$1',[input.id]);
  if(rows.length){const r=rows[0];metadata={id:r.id,kind:input.kind,scope:r.scope,state:r.state,sourceHash:r.source_hash,baseDeployment:r.base_deployment,...traceProjection({deployment:r.deployment,proof:r.proof})};}
 }else return {error:'operation_trace_input_invalid'};
 return {found:!!metadata,...(metadata??{id:input.id,kind:input.kind}),readOnly:true,rawInputsAndOutputsReturned:false,meaning:'Only original stored metadata and explicit identifier fields. Follow an appropriate matching reference. Missing records and HTTP 404 do not prove nonexecution or nonpayment; unknown holds remain unchanged.'};
}
