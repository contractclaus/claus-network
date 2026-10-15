import {createHash} from 'node:crypto';
import {evaluateProgram,programHash} from './runner.mjs';

// This is part of the fixed host, outside the editable source scope. Never
// derive the operation set, identity, project or receipt IDs from guest code.
export const PROGRAM_READS=Object.freeze(['project_get','app_get','app_records','app_metrics','runtime_list','public_project','public_task','public_task_progress','public_task_payment','public_task_review','network_discover','capabilities','app_service_get']);
export const PROGRAM_WRITES=Object.freeze(['app_record_create','app_record_update','app_configure','app_publish','app_service_call']);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bounded=(value,size)=>{const text=JSON.stringify(value);if(typeof text!=='string'||Buffer.byteLength(text)>size)throw Error('network_program_size');return JSON.parse(text);};

export function bindProgramOperation(value,{projectId,runId,index,route,allowWrites}){
 if(!object(value)||Object.keys(value).sort().join(',')!=='input,operation'||!object(value.input))throw Error('network_program_output');
 const write=PROGRAM_WRITES.includes(value.operation);
 if(!PROGRAM_READS.includes(value.operation)&&!write||write&&!allowWrites)throw Error('network_program_operation_denied');
 const definition=route(value.operation);
 if(!definition||(write?definition.method==='GET'||!definition.inputSchema.properties.idempotencyKey:definition.method!=='GET'))throw Error('network_program_route_denied');
 const input=bounded(value.input,16000);
 if(Object.hasOwn(input,'idempotencyKey'))throw Error('network_program_identity_denied');
 if(Object.hasOwn(definition.inputSchema.properties,'projectId')){
  if(Object.hasOwn(input,'projectId')&&input.projectId!==projectId)throw Error('network_program_project_denied');
  input.projectId=projectId;
 }
 const id='network-program:'+hash({runId,index});
 if(write)input.idempotencyKey=id;
 return {id,operation:value.operation,input,write};
}

// No direct I/O enters QuickJS. A returned proposal must pass the sealed host
// route schema, current actor authorization and the original action journal.
export async function runNetworkProgram({program,projectId,runId,context,allowWrites=false,route,validate,invoke,record,evaluate=evaluateProgram}){
 const sourceHash=programHash(program),receipts=[];
 const request=bounded(context,8000);
 for(let index=0;index<4;index++){
  let command;
  try{
   command=await evaluate(program,{projectId,request,receipts},'operate');
   if(object(command)&&Object.keys(command).join(',')==='result')return {state:'completed',sourceHash,receipts,result:bounded(command.result,8000)};
   const bound=bindProgramOperation(command,{projectId,runId,index,route,allowWrites});
   validate(route(bound.operation).inputSchema,bound.input);
   const effect={sourceHash,projectId,runId,index,operation:bound.operation,input:bound.input};
   const receipt=await record(bound.id,effect,async()=>{
    try{
     const value=await invoke(bound.operation,bound.input);
     // An oversized result must not make a successful write look unsuccessful.
     const text=JSON.stringify(value);
     return {state:'completed',operation:bound.operation,value:Buffer.byteLength(text)<=10000?JSON.parse(text):null,...(Buffer.byteLength(text)>10000?{resultOmitted:true,resultHash:hash(value)}:{})};
    }catch(error){
     if(bound.write)throw error; // preserve unknown outcome in the fixed journal
     return {state:'unavailable',operation:bound.operation};
    }
   });
   receipts.push({id:bound.id,...receipt});
   if(receipt.state!=='completed')return {state:'waiting',success:false,sourceHash,receipts,reason:'observation_unavailable'};
   if(receipt.resultOmitted)return {state:'waiting',success:false,sourceHash,receipts,reason:'read_original_result'};
  }catch(error){
   const message=String(error?.message??'');
   return {state:'waiting',success:false,sourceHash,receipts,...(message.startsWith('action_requires_reconciliation:')?{originalActionId:message.slice('action_requires_reconciliation:'.length)}:{}),reason:/^network_program_[a-z_]+$/.test(message)?message:message.startsWith('action_requires_reconciliation:')?'original_action_requires_reconciliation':'program_or_operation_failed',next:'Inspect original receipts; do not replace this run to repeat an uncertain action.'};
  }
 }
 return {state:'bounded',success:false,sourceHash,receipts,reason:'four_operations_completed',next:'Read the original results before deciding on another run.'};
}

// Only this non-financial namespace may be isolated from unrelated work.
// Wallet, social and provider request uncertainty keeps its existing treatment.
export function isolateProgramActions(actions){
 const held=[],blocking=[];
 for(const action of actions){
  if(action.kind==='network_program'&&/^network-program:[a-f0-9]{64}$/.test(action.id??'')||
     action.kind==='network_program_run'&&/^network-program-run:[a-f0-9]{64}$/.test(action.id??''))held.push(action);
  else blocking.push(action);
 }
 return {held,blocking};
}

export async function reconcileProgramActions(actions,resume){
 const results=[];
 for(const action of isolateProgramActions(actions).held.filter(action=>action.kind==='network_program').slice(0,2)){
  try{await resume({id:action.id});results.push({id:action.id,state:'reconciled'});}
  catch{results.push({id:action.id,state:'original_outcome_held'});}
 }
 return results;
}
