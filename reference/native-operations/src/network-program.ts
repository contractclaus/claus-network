import program from './isolated/network.json' with {type:'json'};
import {runNetworkProgram,PROGRAM_READS,PROGRAM_WRITES} from './isolated/operations.mjs';
import {networkRoutes,validate} from './network-routes.js';
import {createNetworkAccess} from './network-access.js';
import {once,sql,settleAction,configuration} from './store.js';
import {operationsEnabled} from './operations/service.js';
import {bindProgramOperation} from './isolated/operations.mjs';
import {reconcileProgramActions} from './isolated/operations.mjs';
import {digest} from './config.js';

const access=createNetworkAccess();
export const networkProgramDefinitions=[{type:'function',function:{name:'run_network_program',description:'Run operate(input) from your reviewed editable src/isolated/network.json in the credential-free engine. Supply an existing network_work id/revision and a project you can access. input contains projectId, your JSON request, and original receipts from up to four sealed API operations. Return {operation,input} or {result}. Allowed reads: '+PROGRAM_READS.join(', ')+'. With allowWrites=true, allowed writes: '+PROGRAM_WRITES.join(', ')+'. Project identity and original idempotency keys are fixed by the host. This cannot grant permissions, sign, spend, post on X, modify database records directly or change its operation allowlist. Missing operate leaves existing analysis unchanged. Review current receipts before another run; never replace an uncertain run.',parameters:{type:'object',properties:{workId:{type:'string'},expectedRevision:{type:'integer',minimum:1},projectId:{type:'string'},request:{type:'string',description:'JSON object for your program, at most 8000 bytes.'},allowWrites:{type:'boolean'}},required:['workId','expectedRevision','projectId','request','allowWrites'],additionalProperties:false}}}];

export async function networkProgram(actionId:string,args:any){
 if(!args||Object.keys(args).some(k=>!['workId','expectedRevision','projectId','request','allowWrites'].includes(k))||typeof args.workId!=='string'||args.workId.length>200||!Number.isSafeInteger(args.expectedRevision)||args.expectedRevision<1||typeof args.projectId!=='string'||args.projectId.length>256||typeof args.request!=='string'||Buffer.byteLength(args.request)>8000||typeof args.allowWrites!=='boolean')throw Error('network_program_input');
 const request=JSON.parse(args.request);if(!request||typeof request!=='object'||Array.isArray(request))throw Error('network_program_input');
 await currentAuthority(args.workId,args.expectedRevision);
 const pending=await sql()`SELECT id FROM claus_actions WHERE kind='network_program' AND status NOT IN ('completed','failed') AND (input->>'projectId'=${args.projectId} OR input->>'workId'=${args.workId}) LIMIT 1`;
 if(pending.length)return {state:'waiting',success:false,originalActionId:pending[0].id,reason:'original_action_requires_reconciliation'};
 await access.call('project_get',{projectId:args.projectId});
 return runNetworkProgram({program,projectId:args.projectId,runId:actionId,context:request,allowWrites:args.allowWrites,route:(name:string)=>networkRoutes[name],validate,invoke:access.call,record:async(id:string,input:any,fn:()=>Promise<any>)=>{
  await currentAuthority(args.workId,args.expectedRevision);
  return once(id,'network_program',{...input,workId:args.workId,workRevision:args.expectedRevision},fn);
 }});
}

async function currentAuthority(workId:string,revision:number){
 const config=await configuration();
 if(!operationsEnabled(config)||config.policy.capabilities.networkBuild!==true)throw Error('network_program_disabled');
 const [work]=await sql()`SELECT id,revision,status FROM claus_network_work WHERE id=${workId}`;
 if(!work||Number(work.revision)!==revision||!['ready','working'].includes(work.status))throw Error('network_program_work_changed');
 const [control]=await sql()`SELECT enabled FROM claus_operations_control WHERE scope='native'`;
 if(control?.enabled!==true)throw Error('network_program_disabled');
}

export const resumeNetworkProgramDefinition={type:'function',function:{name:'resume_network_operation',description:'Explicitly reconcile one original network-program operation using its original API idempotency key. Read the original receipt first. This only accepts operations produced by run_network_program; it cannot repeat old wallet, review, social or hook actions. It returns the original step, not a new run. An inactive or revised work item requires operator reconciliation; never create a replacement to bypass it.',parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false}}};
export async function resumeNetworkOperation(args:any){
 if(!args||Object.keys(args).join(',')!=='id'||!/^network-program:[a-f0-9]{64}$/.test(args.id))throw Error('network_program_identity_denied');
 const [row]=await sql()`SELECT id,kind,input,input_hash,status,result FROM claus_actions WHERE id=${args.id}`;
 if(!row||row.kind!=='network_program'||digest(row.input)!==row.input_hash)throw Error('network_program_identity_denied');
 if(row.status==='completed')return {id:row.id,...row.result};
 if(!['pending','uncertain'].includes(row.status))throw Error('network_program_terminal');
 const saved=row.input;
 await currentAuthority(saved.workId,saved.workRevision);
 const input={...saved.input};delete input.idempotencyKey;
 const bound=bindProgramOperation({operation:saved.operation,input},{projectId:saved.projectId,runId:saved.runId,index:saved.index,route:(name:string)=>networkRoutes[name],allowWrites:true});
 if(bound.id!==row.id||digest(bound.input)!==digest(saved.input))throw Error('network_program_identity_denied');
 validate(networkRoutes[bound.operation].inputSchema,bound.input);
 const value=await access.call(bound.operation,bound.input);
 const text=JSON.stringify(value),result={state:'completed',operation:bound.operation,value:Buffer.byteLength(text)<=10000?value:null,...(Buffer.byteLength(text)>10000?{resultOmitted:true,resultHash:digest(value)}:{})};
 await settleAction(row.id,result);
 const [confirmed]=await sql()`SELECT status,result FROM claus_actions WHERE id=${row.id}`;
 if(confirmed?.status!=='completed')throw Error('network_program_terminal_conflict');
 return {id:row.id,...confirmed.result};
}

export async function reconcileNetworkPrograms(){
 const pending=await sql()`SELECT id,kind FROM claus_actions WHERE kind='network_program' AND status NOT IN ('completed','failed') ORDER BY created_at,id LIMIT 2`;
 return reconcileProgramActions(pending,resumeNetworkOperation);
}
