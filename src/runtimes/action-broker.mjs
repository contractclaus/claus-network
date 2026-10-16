import {copy,digest,requireThat} from '../shared/index.mjs';

export const RUNTIME_ACTIONS=Object.freeze(['app_service_get','app_service_call','project_web_read','network_discover','public_project','public_app','public_task','public_task_progress','public_task_payment','app_join','app_get','app_records','app_task_messages','app_task_message','app_task_review_request','app_task_review_submit','app_task_post','app_task_claim','app_task_deliver','app_task_accept','app_record_create','app_record_update','inference_profiles','inference_profile','inference_submit','inference_get','inference_output']);

// Worker JSON may name an operation, never choose a URL, credential, SQL statement
// or signer. The host keeps the actor and calls the same authorized API routes.
export function bindAction(action,{route,projectId,cycleKey}) {
 requireThat(action&&RUNTIME_ACTIONS.includes(action.operation),'runtime_action_denied');
 const definition=route(action.operation);requireThat(definition,'runtime_action_denied');
 const input=copy(action.input??{});
 requireThat(input&&!Array.isArray(input)&&typeof input==='object','runtime_action_denied');
 if(action.operation.startsWith('inference_')||action.operation==='project_web_read')input.projectId=projectId;
 if(definition.inputSchema.properties.idempotencyKey)input.idempotencyKey=cycleKey;
 return {kind:'action',operation:action.operation,input,idempotent:definition.method==='GET'||!!definition.inputSchema.properties.idempotencyKey,sending:false};
}

// A stored idempotent flag is not authority. Re-derive it from the current fixed
// route and original cycle key on recovery, including payload binding for costs.
export async function recoveryFor(work,{id,route,reader,now}) {
 const action=work.pending;if(action?.kind!=='action')return {allowed:false,reason:'not_an_action'};
 if(!RUNTIME_ACTIONS.includes(action.operation))return {allowed:false,reason:'action_not_allowed'};
 const definition=route(action.operation);if(!definition)return {allowed:false,reason:'route_unavailable'};
 const own=['project_web_read',...RUNTIME_ACTIONS.filter(n=>n.startsWith('inference_'))];
 if(own.includes(action.operation)&&action.input.projectId!==work.projectId)return {allowed:false,reason:'project_mismatch'};
 const retryCount=action.recoveryAttempts??0;
 if(!Number.isSafeInteger(retryCount)||retryCount<0||retryCount>=3)return {allowed:false,reason:'recovery_exhausted'};
 const key='runtime:'+digest({id,cycle:work.cycle}).slice(7);
 const durable=!!definition.inputSchema.properties.idempotencyKey&&action.input.idempotencyKey===key;
 if(action.operation==='project_web_read')return {allowed:false,reason:'metered_read_requires_owner'};
 if(action.operation==='inference_submit'){
  if(!durable)return {allowed:false,reason:'original_key_mismatch'};
  const original=await reader.read('inference-requests',digest({projectId:work.projectId,inference:action.input.idempotencyKey}));
  const {projectId,idempotencyKey,...request}=action.input;
  if(!original||original.value.requestHash!==digest(request))return {allowed:false,reason:'financial_outcome_unresolved'};
 }else if(definition.method!=='GET'&&!durable)return {allowed:false,reason:'non_idempotent_action'};
 return {allowed:true,reason:'same_original_request',nextAt:now+Math.min(300000,15000*2**retryCount),pending:{...action,recoveryAttempts:retryCount+1}};
}
