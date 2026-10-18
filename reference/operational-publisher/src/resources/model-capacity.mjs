import {digest,sameValue} from './store.mjs';
import {providerRequest} from '../infrastructure/providers.mjs';
export const modelCapacityInputs={model_capacity:[],model_capacity_update:['expectedHash','workersMax','idleTimeout','queueDelaySeconds'],model_capacity_result:['actionId']};
const fail=code=>{throw Error('resource_model_capacity_'+code);};
export function managedModelCapacity({store,env=process.env,request=fetch,now=Date.now}){
 const endpoint=()=>{if(!/^[a-z0-9]{8,40}$/.test(env.CONTINUITY_RUNPOD_ENDPOINT??'')||!env.CLAUS_RUNPOD_API_KEY)fail('unconfigured');return env.CONTINUITY_RUNPOD_ENDPOINT;};
 const provider=(path,options)=>providerRequest(request,'https://rest.runpod.io/v1'+path,env.CLAUS_RUNPOD_API_KEY,options);
 const selection=v=>({id:v.id,templateId:v.templateId,gpuCount:v.gpuCount,gpuTypeIds:v.gpuTypeIds,workersMin:v.workersMin,workersMax:v.workersMax,idleTimeout:v.idleTimeout,scalerType:v.scalerType,scalerValue:v.scalerValue,executionTimeoutMs:v.executionTimeoutMs});
 async function current(){const v=await provider('/endpoints/'+endpoint());if(v.id!==endpoint()||v.templateId!==env.CONTINUITY_RUNPOD_TEMPLATE||v.gpuCount!==1||v.workersMin!==0||v.executionTimeoutMs!==900000)fail('binding_changed');return selection(v);}
 async function allowance(){
  const origin=new URL(env.CONTINUITY_URL);if(origin.protocol!=='https:'||origin.pathname!=='/')fail('origin_invalid');
  const r=await request(origin.origin+'/v1/status',{headers:{authorization:'Bearer '+env.CONTINUITY_OPERATOR_SECRET},redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)fail('funding_unavailable');
  const v=await r.json();if(!Array.isArray(v.grants))fail('funding_invalid');
  const available=v.grants.filter(g=>Date.parse(g.expires_at)>now()+16*60000).reduce((sum,g)=>sum+BigInt(g.amount_micro)-BigInt(g.allocated_micro),0n);
  return {availableMicroUsd:String(available),maximumFundedWorkers:Number(available/2000000n)};
 }
 async function unlock(id){const lock=await store.get('model-capacity-lock',endpoint());if(lock?.active===id)await store.change('model-capacity-lock',endpoint(),lock.revision,{revision:lock.revision+1,active:null});}
 async function result(id){
  if(!/^act_[a-f0-9]{24}$/.test(id??''))fail('action_invalid');const action=await store.get('action',id);if(action?.operation!=='model_capacity_update')fail('action_missing');
  if(action.output){await unlock(id);return action.output;}
  if(action.phase==='prepared')return {actionId:id,state:'not_dispatched',retry:false};
  const observed=await current();
  if(Object.entries(action.prepared.patch).every(([k,v])=>sameValue(observed[k],v))){const out=await store.complete(id,{actionId:id,state:'applied',configuration:observed,configurationHash:digest(observed),observedAt:new Date(now()).toISOString()});await unlock(id);return out;}
  return {actionId:id,state:'outcome_unknown',retry:false,configuration:observed};
 }
 async function call(operation,input,requestId){
  if(operation==='model_capacity'){const configuration=await current();return {endpointId:endpoint(),configuration,configurationHash:digest(configuration),funding:await allowance(),pendingAction:(await store.get('model-capacity-lock',endpoint()))?.active??null,observedAt:new Date(now()).toISOString(),billing:'Workers scale to zero. Every new inference retains its original prepaid authorization under the shared operating budget.'};}
  if(operation==='model_capacity_result')return result(input.actionId);
  if(typeof requestId!=='string'||!requestId||requestId.length>200||!Number.isInteger(input.workersMax)||input.workersMax<0||input.workersMax>250||!Number.isInteger(input.idleTimeout)||input.idleTimeout<1||input.idleTimeout>30||!Number.isInteger(input.queueDelaySeconds)||input.queueDelaySeconds<1||input.queueDelaySeconds>120||!/^[a-f0-9]{64}$/.test(input.expectedHash??''))fail('input_invalid');
  const id='act_'+digest(['model-capacity',requestId]).slice(0,24),old=await store.get('action',id);if(old){if(!sameValue(old.input,input))fail('request_conflict');if(old.phase!=='prepared')return result(id);}
  const observed=await current();if(digest(observed)!==input.expectedHash)fail('configuration_changed');
  const funding=input.workersMax===0?{availableMicroUsd:null,maximumFundedWorkers:0}:await allowance();if(input.workersMax>funding.maximumFundedWorkers)fail('additional_prepaid_allowance_required');
  const patch={workersMin:0,workersMax:input.workersMax,idleTimeout:input.idleTimeout,scalerType:'QUEUE_DELAY',scalerValue:input.queueDelaySeconds};
  await store.begin(id,'model_capacity_update',input,{endpointId:endpoint(),patch,prior:observed,funding});
  await store.put('model-capacity-lock',endpoint(),{revision:1,active:null});const lock=await store.get('model-capacity-lock',endpoint());if(lock.active&&lock.active!==id)fail('original_change_pending');
  if(!lock.active)await store.change('model-capacity-lock',endpoint(),lock.revision,{revision:lock.revision+1,active:id});
  if(!await store.dispatch(id))return result(id);
  try{await provider('/endpoints/'+endpoint(),{method:'PATCH',body:patch});}catch{return {actionId:id,state:'outcome_unknown',retry:false};}
  return result(id);
 }
 return {call};
}
