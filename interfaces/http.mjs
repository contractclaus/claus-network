import {openapi} from './contract.mjs';
const errors={project_profile_mismatch:409,registration_profile_mismatch:409,reserved_module_selector:400,managed_binding_missing:409,managed_registry_changed:409,managed_previous_source_missing:409,managed_previous_code_changed:409,managed_evidence_mismatch:409,managed_initial_mismatch:409,managed_consumer_unsupported:400,intake_profile_not_admitted:409,unauthenticated:401,invalid_signature:401,challenge_expired:401,scope_denied:403,access_denied:403,not_found:404,revision_conflict:409,idempotency_conflict:409,slug_taken:409,rate_limited:429,capacity_reached:429,build_in_progress:409,build_not_complete:409,entry_missing:400,effect_requires_reconciliation:409,job_terminal:409,capability_not_available:503,
 project_admission_paused:409,project_unavailable:409,sponsor_not_enabled:403,sponsor_limit:403,sponsor_exhausted:409,review_in_progress:409,source_not_published:409,unsupported_source_host:400,quote_not_ready:409,review_not_complete:409,quote_expired:409,quote_input_mismatch:409,quote_already_admitted:409,provider_offer_already_admitted:409,funding_insufficient:409,
 unsupported_module:400,unsupported_delay:400,executor_delay_required:409,unsupported_profile:400,module_not_verified:409,project_not_registered:409,
 project_already_registered:409,registration_in_progress:409,registration_limit:409,registration_expired:409,proposal_in_progress:409,decision_not_complete:409,review_context_too_large:413,chain_not_enabled:409,chain_public_not_enabled:409,chain_admission_changed:409,chain_scope_not_reviewed:409,chain_gas_exhausted:409,project_chain_mismatch:409,chain_not_configured:409,unsupported_chain:400,
 service_not_found:404,service_version_conflict:409,service_not_available:409,service_schema_mismatch:400,service_payload_too_large:413,
 service_order_busy:409,payment_mismatch:409,receipt_already_used:409,result_not_ready:409,result_mismatch:409,acceptance_conflict:409,lease_lost:409,
 wallets_not_enabled:409,collaboration_not_enabled:409,wallet_not_verified:409,wallet_profile_changed:409,session_payment_denied:403,
 session_stale:409,session_retired:409,session_expired:409,payment_expired:409,payment_not_pending:409,payment_already_pending:409,
 payment_already_complete:409,unsupported_payment_asset:400,vaults_not_enabled:409,vault_not_verified:409,
 vault_profile_changed:409,policy_not_verified:409,vault_deployment_expired:409,vault_code_changed:409,project_binding_changed:409,
 portability_not_enabled:409,project_transferred:409,transfer_conflict:409,import_conflict:409,project_id_taken:409,
 transfer_too_large:413,archive_pages_missing:409,archive_page_corrupt:400,archive_source_corrupt:400,
 transfer_destination_mismatch:400,transfer_fence_mismatch:400,archive_owner_mismatch:403,untrusted_archive_operator:403,
 invalid_archive_signature:400,archive_key_mismatch:400,archive_pages_mismatch:400,unsupported_archive:400,
 dependency_code_missing:409,dependency_indirection_unsupported:400,dependency_delegation_unsupported:400,
 dependency_proxy_unsupported:400,dependency_evidence_mismatch:409,dependency_code_changed:409,evidence_block_changed:409,
 build_evidence_mismatch:409,inference_disabled:409,inference_profile_unavailable:409,inference_profile_changed:409,
 inference_profile_immutable:409,inference_allowance_unavailable:403,inference_allowance_exhausted:409,
 inference_allowance_below_exposure:409,inference_request_outside_profile:400,inference_quote_unverified:409,
 inference_quote_mismatch:409,inference_output_unavailable:409,
 contract_intake_disabled:409,contract_binding_inactive:409,contract_binding_exhausted:409,
 durable_agent_required:403,binding_exceeds_authority:400,decision_capacity_reached:409,contract_request_in_progress:409,
 contract_request_closed:409,contract_event_changed:409,contract_request_mismatch:400,
 public_data_not_enabled:409,public_result_unavailable:404,result_source_changed:409,
 result_lineage_invalid:400,result_lineage_too_deep:400,
 signal_eoa_required:400,signal_factory_changed:409,signal_grant_inactive:409,signal_grant_exhausted:409,
 signal_grant_not_found:404,signal_grant_stale:409,signal_nonce_used:409,signal_stale_version:409,
 signal_stale_sequence:409,signal_data_expired:409,signal_interval_pending:409,signal_store_exists:409,
 signal_store_mismatch:409,signal_transaction_mismatch:400,signal_transaction_reorganized:409,signal_transaction_reverted:409,
 signal_admission_changed:409,signal_api_revoked:403,signal_not_enabled:409,signal_operation_expired:409,signal_grant_expiry:400,
 signal_scope_not_reviewed:409,signal_signature_required:409,signal_source_changed:409,
 signal_store_not_registered:409,signal_transaction_conflict:409,signal_budget_exhausted:409,
 invalid_contract_input:400,invalid_address:400,invalid_word:400};
export const errorStatus=error=>errors[error.code]??(/^(invalid_|unknown_|missing_|duplicate_|value_|file_|snapshot_|document_)/.test(error.code??'')?400:503);
export const errorBody=error=>{
 const status=errorStatus(error),code=error.code&&status!==503?error.code:'service_unavailable';
 const category=status===401?'authentication':status===403?'authorization':status===429?'capacity':
  status===400||status===413?'input':code==='funding_insufficient'?'funding':
  code==='decision_capacity_reached'?'capacity':code==='effect_requires_reconciliation'?'unknown_outcome':status>=500?'availability':'state';
 return {error:code,category,retryable:status>=500||status===429,
  ...(status===429?{retryAfterSeconds:60}:{}),
  ...(status===400&&typeof error.field==='string'&&error.field.length<200?{field:error.field}:{})};
};
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...headers}});
export async function body(request,maximum=300000){
 const declared=request.headers.get('content-length');
 if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maximum))throw Object.assign(Error('invalid_body_size'),{code:'invalid_body_size'});
 if(!request.body)return {};
 const reader=request.body.getReader();let size=0;const chunks=[];
 try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>maximum)throw Object.assign(Error('invalid_body_size'),{code:'invalid_body_size'});chunks.push(value);}}
 catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 if(size===0)return {};
 if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')??''))throw Object.assign(Error('invalid_content_type'),{code:'invalid_content_type'});
 try{const all=new Uint8Array(size);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));}
 catch{throw Object.assign(Error('invalid_json'),{code:'invalid_json'});}
}
export function createHttp({service,origin='https://claus.si',admit=async()=>{}}){
 const routes=service.routes.map(route=>({...route,names:[...route.path.matchAll(/\{(\w+)\}/g)].map(m=>m[1]),pattern:new RegExp('^'+route.path.replace(/\{\w+\}/g,'([^/]+)')+'$')}));
 return async(request,context={})=>{
  try{
   const url=new URL(request.url),callerOrigin=request.headers.get('origin');
   if(callerOrigin&&callerOrigin!==origin)return json({error:'wrong_origin',retryable:false},403);
   if(request.method==='GET'&&url.pathname==='/openapi.json')return json(openapi({origin}));
   const matched=routes.find(r=>r.method===request.method&&r.pattern.test(url.pathname));
   if(!matched)return json({error:'not_found',retryable:false},404);
   await admit({route:matched.name,peer:context.peer??'unknown'});
   const match=url.pathname.match(matched.pattern),input={};
   for(let i=0;i<matched.names.length;i++){
    const name=matched.names[i],value=decodeURIComponent(match[i+1]);
    if(matched.inputSchema.properties[name]?.type==='integer'){
     if(!/^(0|[1-9][0-9]*)$/.test(value))throw Object.assign(Error('invalid_path_parameter'),{code:'invalid_input',field:name});
     input[name]=Number(value);
    }else input[name]=value;
   }
   if(request.method==='GET'){
    for(const [name,value] of url.searchParams){
     if(Object.hasOwn(input,name))throw Object.assign(Error('duplicate_field'),{code:'invalid_input'});
     input[name]=matched.inputSchema.properties[name]?.type==='integer'?Number(value):value;
    }
   }else{
    const parsed=await body(request);
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Object.assign(Error('invalid_input'),{code:'invalid_input'});
    for(const [name,value] of Object.entries(parsed)){
     if(Object.hasOwn(input,name))throw Object.assign(Error('duplicate_field'),{code:'invalid_input'});
     input[name]=value;
    }
   }
   const auth=request.headers.get('authorization');
   const token=auth?.match(/^Bearer (cln_[A-Za-z0-9_-]{43})$/)?.[1];
   return json(await service.execute(matched.name,input,token));
  }catch(error){const status=errorStatus(error);return json(errorBody(error),status,status===401?{'www-authenticate':'Bearer realm="Claus Network"'}:status===429?{'retry-after':'60'}:{});}
 };
}
