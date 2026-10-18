import {requestDiagnostics} from './request-diagnostics.mjs';
import {SITE_LIMITS} from '../src/shared/index.mjs';
import {openapi} from './contract.mjs';
const BROWSER_APP_OPERATIONS=new Set(['app_service_get','app_service_call','app_task_messages','app_task_message','public_task_review','app_task_review_request','app_task_review_submit','app_task_review_challenge','public_app','public_app_records','auth_challenge','auth_session','credential_revoke','app_join','app_session_create','app_session_revoke','app_get','app_records','app_record_create','app_record_update','app_task_post','app_task_claim','app_task_deliver','app_task_accept','app_task_cancel','app_events']);
const infrastructureErrors={oci_invalid_visibility:400,oci_private_not_enabled:409,oci_private_key_unavailable:503,oci_private_scope_invalid:400,oci_private_context_invalid:422,maintenance_service_required:409,maintenance_budget_invalid:400,maintenance_changed:409,maintenance_budget_exhausted:409,maintenance_deadline:409,infrastructure_daily_limit:429,infrastructure_policy_unavailable:409,infrastructure_budget_exhausted:409,infrastructure_project_limit:409,infrastructure_controlled_grant_required:409,oci_layout_invalid:422,oci_image_storage_mismatch:503,oci_image_storage_unavailable:503,infrastructure_not_enabled:409,infrastructure_profile_disabled:409,infrastructure_allowance_unavailable:409,infrastructure_allowance_exhausted:409,infrastructure_capacity_reached:429,infrastructure_profile_immutable:409,allowance_below_obligations:409,infrastructure_quote_expired:409,infrastructure_quote_already_used:409,infrastructure_profile_changed:409,infrastructure_quote_over_limit:409,infrastructure_target_not_allowed:403,infrastructure_size_not_allowed:403,infrastructure_gpu_not_allowed:403,infrastructure_gpu_not_supported:409,infrastructure_release_not_approved:409,resource_must_stop_and_settle:409,immutable_image_required:400,unexpected_service_port:400,manifest_too_large:413,oci_files_invalid:400,oci_path_invalid:400,oci_private_file:400,oci_context_invalid:400,oci_dockerfile_unsupported:400,oci_from_invalid:400,oci_base_digest_required:400,oci_base_missing:400,oci_frontend_digest_required:400,oci_package_lock_required:400};
const dealErrors={unsupported_deal_asset:400,insufficient_deal_token_balance:409,deal_capacity_reached:409,deal_already_funded:409,task_payment_missing:409,task_payment_not_ready:409,task_payment_exit_required:409,deal_worker_unavailable:503,deal_subsidy_minimum:409,deal_arbitration_disabled:409,deal_arbitration_capacity:429,deal_evidence_capacity:429,deal_party_required:403,deal_not_reviewable:409,invalid_deal_id:400,invalid_deal_evidence:400,deal_evidence_mismatch:409,deal_evidence_too_large:413,resolution_unavailable:409,deals_not_enabled:409,invalid_deal_input:400,invalid_deal_action:400,invalid_deal_pins:503,deal_pin_mismatch:409,deal_simulation_failed:409};
const errors={commerce_unavailable:503,commerce_chain_unavailable:503,commerce_product_unavailable:409,commerce_report_not_ready:409,commerce_report_too_large:413,commerce_price_limit:409,commerce_payment_conflict:409,commerce_payment_reused:409,commerce_rate_limited:429,commerce_key_revoked:401,commerce_unpaid:409,commerce_refund_window:409,commerce_support_open:409,commerce_settlement_conflict:409,commerce_settlement_unavailable:503,runtime_image_private_owner_review_required:409,runtime_image_owner_scope_denied:403,runtime_image_owner_review_invalid:400,runtime_image_owner_review_incomplete:409,search_admission_unavailable:503,runtime_private_data_denied:403,runtime_data_project_mismatch:403,runtime_data_too_large:413,runtime_data_access_invalid:400,app_database_backup_changed:409,app_database_backup_too_large:413,data_verification_busy:429,data_not_utf8:422,data_capacity_reached:429,data_upload_expired:409,data_upload_state_changed:409,data_upload_not_found:409,data_upload_integrity_failed:422,data_file_not_ready:409,data_content_invalid:400,data_inline_size_invalid:413,data_inline_read_too_large:413,data_delete_state_changed:409,runtime_image_build_unverified:409,runtime_image_claus_required:403,runtime_image_project_unavailable:409,runtime_image_unavailable:409,runtime_image_changed:409,runtime_image_review_incomplete:409,runtime_image_review_not_public:409,runtime_image_source_unverified:409,runtime_image_blocking_review:409,runtime_image_endorsement_missing:409,runtime_image_manifest_invalid:400,runtime_image_decision_invalid:400,source_storage_unavailable:503,r2_read_unavailable:503,r2_write_outcome_unknown:503,r2_write_not_visible:503,artifact_corrupt:503,partner_context_revoked:409,partner_launch_not_enabled:409,partner_assignment_changed:409,partner_project_owner_changed:409,partner_project_suspended:409,partner_claus_decision_required:403,partner_owner_consent_required:403,partner_self_token_forbidden:403,partner_review_incomplete:409,partner_review_not_settled:409,partner_source_unverified:409,partner_review_not_public:409,partner_component_not_reviewed:409,partner_report_incomplete:409,partner_report_source:409,partner_blocking_review:409,partner_explicit_endorsement_missing:409,partner_decision_changed:409,partner_admission_revoked:409,partner_admission_changed:409,partner_build_mismatch:409,partner_component_not_compiled:409,partner_decision_incomplete:400,partner_decision_expiry:400,partner_request_mismatch:400,partner_request_source_missing:400,partner_context_invalid:400,partner_independence_evidence_required:400,partner_components_invalid:400,partner_request_file_invalid:400,partner_project_mismatch:400,partner_request_too_large:413,partner_request_depth:400,partner_request_number:400,partner_request_json:400,service_source_changed:409,app_service_unavailable:409,isolated_program_invalid:400,isolated_service_failed:422,isolated_service_input_size:413,isolated_service_output_size:413,isolated_service_output_invalid:422,runtime_state_too_large:413,invalid_runtime_id:400,invalid_runtime:400,runtime_busy:409,runtime_action_denied:403,runtime_output_requires_state:400,compute_policy_managed:409,compute_policy_unavailable:409,compute_budget_exhausted:409,compute_project_limit:409,compute_funding_insufficient:409,inference_profile_not_supported:409,compute_budget_below_commitments:409,compute_operator_unknown:404,invalid_compute_limit:400,invalid_compute_policy:400,invalid_compute_grant:400,invalid_compute_operators:400,compute_profile_already_exists:409,inference_allowance_below_exposure:409,revoked_compute_grant_must_preserve_exposure:400,invalid_task_review:400,task_review_conflict:403,task_review_stale:409,task_review_expired:409,task_review_unavailable:409,task_review_deadline:409,task_review_commission_invalid:409,task_review_commission_unfunded:409,task_review_already_submitted:409,task_review_not_submitted:409,task_review_evidence_missing:400,task_review_already_challenged:409,workers_not_enabled:409,worker_unavailable:409,worker_project_busy:429,worker_capacity_reached:429,worker_daily_limit:429,worker_json_too_large:413,domains_not_enabled:409,domain_taken:409,domain_revoked:409,domain_release_unavailable:409,workflow_inactive:409,workflow_step_changed:409,app_export_changed:409,app_writes_paused:409,apps_not_enabled:409,app_membership_required:403,app_schema_migration_required:409,app_task_busy:409,review_scope_conflict:409,project_suspended:409,project_profile_mismatch:409,registration_profile_mismatch:409,reserved_module_selector:400,managed_binding_missing:409,managed_registry_changed:409,managed_previous_source_missing:409,managed_previous_code_changed:409,managed_evidence_mismatch:409,managed_initial_mismatch:409,managed_consumer_unsupported:400,managed_state_invalid:409,managed_version_invalid:409,managed_initial_state_invalid:409,intake_profile_not_admitted:409,unauthenticated:401,invalid_signature:401,challenge_expired:401,scope_denied:403,access_denied:403,not_found:404,revision_conflict:409,idempotency_conflict:409,slug_taken:409,rate_limited:429,capacity_reached:429,build_in_progress:409,build_not_complete:409,entry_missing:400,effect_requires_reconciliation:409,job_terminal:409,capability_not_available:503,
 project_admission_paused:409,project_unavailable:409,sponsor_not_enabled:403,sponsor_limit:403,sponsor_exhausted:409,review_in_progress:409,source_not_published:409,unsupported_source_host:400,quote_not_ready:409,review_not_complete:409,quote_expired:409,quote_input_mismatch:409,quote_already_admitted:409,provider_offer_already_admitted:409,funding_insufficient:409,
 unsupported_module:400,unsupported_delay:400,executor_delay_required:409,unsupported_profile:400,module_not_verified:409,project_not_registered:409,
 oci_source_too_large:413,oci_builds_not_enabled:409,oci_public_source_consent_required:400,oci_build_capacity_reached:429,oci_source_not_public:409,oci_plan_changed:409,
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
export const knownErrorCode=error=>{const c=error?.code;return [infrastructureErrors,dealErrors,errors].some(m=>Object.hasOwn(m,c))?c:null;};
export const errorStatus=error=>infrastructureErrors[error?.code]??dealErrors[error?.code]??errors[error?.code]??(/^(invalid_|unknown_|missing_|duplicate_|value_|file_|snapshot_|document_)/.test(error?.code??'')?400:503);
export const errorBody=error=>{
 error=error??{};
 const status=errorStatus(error),code=error.code&&status!==503?error.code:'service_unavailable';
 const category=status===401?'authentication':status===403?'authorization':status===429?'capacity':
  status===400||status===413?'input':code==='funding_insufficient'?'funding':
  code==='decision_capacity_reached'?'capacity':code==='effect_requires_reconciliation'?'unknown_outcome':status>=500?'availability':'state';
 return {error:code,category,retryable:status>=500||status===429,
  ...(status===429&&Number.isSafeInteger(error.retryAt)?{retryAt:error.retryAt}:{}),
  ...(status===429?{retryAfterSeconds:Number.isSafeInteger(error.retryAfterSeconds)&&error.retryAfterSeconds>0?(Number.isSafeInteger(error.retryAt)?error.retryAfterSeconds:Math.min(300,error.retryAfterSeconds)):60}:{}),
  ...(code==='oci_build_capacity_reached'&&['project_concurrency','global_concurrency','public_window'].includes(error.capacityScope)?{capacityScope:error.capacityScope}:{}),
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
  let cors={},matched,phase='route';
  const diagnostic=requestDiagnostics(request,{requestId:context.requestId,origin});
  const reply=(data,status=200,headers={})=>json(data,status,{...headers,...diagnostic.headers,...(headers['access-control-allow-origin']?{'access-control-expose-headers':'x-claus-request-id'}:{})});
  try{
   const url=new URL(request.url),callerOrigin=request.headers.get('origin');
   if(request.method==='GET'&&url.pathname==='/openapi.json')return reply(openapi({origin}),200,{'access-control-allow-origin':'*'});
   const preflight=request.method==='OPTIONS',method=preflight?request.headers.get('access-control-request-method'):request.method;
   matched=routes.find(r=>r.method===method&&r.pattern.test(url.pathname));
   if(!matched)return reply({error:'not_found',retryable:false},404);
   const publicRead=matched.public&&method==='GET',clausApp=callerOrigin==='https://claus.si'&&(BROWSER_APP_OPERATIONS.has(matched.name)||matched.name.startsWith('commerce_'));
   if(callerOrigin&&callerOrigin!==origin&&!publicRead&&!clausApp){diagnostic.failure({status:403,code:'wrong_origin',operation:matched.name,route:matched.path,phase});return reply({error:'wrong_origin',retryable:false,requestId:diagnostic.id},403);}
   cors=publicRead?{'access-control-allow-origin':'*'}:clausApp?{'access-control-allow-origin':'https://claus.si',vary:'Origin'}:{};
   if(preflight){
    const headers=(request.headers.get('access-control-request-headers')??'').toLowerCase().split(',').map(h=>h.trim()).filter(Boolean);
    if(!Object.keys(cors).length||headers.some(h=>!['authorization','content-type'].includes(h))){diagnostic.failure({status:403,code:'wrong_origin',operation:matched.name,route:matched.path,phase});return reply({error:'wrong_origin',retryable:false,requestId:diagnostic.id},403);}
    return new Response(null,{status:204,headers:{...cors,'access-control-allow-methods':method,'access-control-allow-headers':'authorization, content-type','access-control-max-age':'300'}});
   }
   phase='admission';
   await admit({route:matched.name,peer:context.peer??'unknown'});
   phase='decode';
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
     const type=matched.inputSchema.properties[name]?.type;
     if(type==='array'){try{input[name]=JSON.parse(value);}catch{throw Object.assign(Error('invalid_input'),{code:'invalid_input'});}}
     else input[name]=type==='integer'?Number(value):value;
    }
   }else{
    const parsed=await body(request,['snapshot_create','content_admin_correct'].includes(matched.name)?SITE_LIMITS.requestBytes:300000);
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Object.assign(Error('invalid_input'),{code:'invalid_input'});
    for(const [name,value] of Object.entries(parsed)){
     if(Object.hasOwn(input,name))throw Object.assign(Error('duplicate_field'),{code:'invalid_input'});
     input[name]=value;
    }
   }
   const auth=request.headers.get('authorization');
   const token=auth?.match(/^Bearer (cln_[A-Za-z0-9_-]{43})$/)?.[1];
   phase='execute';
   return reply(await service.execute(matched.name,input,token,{signal:request.signal}),200,cors);
  }catch(error){const status=errorStatus(error);diagnostic.failure({status,error,code:knownErrorCode(error),operation:matched?.name,route:matched?.path,phase});return reply({...errorBody(error),requestId:diagnostic.id},status,{...cors,...(status===401?{'www-authenticate':'Bearer realm="Claus Network"'}:status===429?{'retry-after':String(errorBody(error).retryAfterSeconds)}:{})});}
 };
}
