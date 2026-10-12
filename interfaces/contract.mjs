export const API_VERSION='0.9.3';
const string=(maxLength=256)=>({type:'string',minLength:1,maxLength});
const integer={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER};
const boolean={type:'boolean'};
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const file=object({path:string(180),content:{type:'string',maxLength:48000}});
const route=(name,method,path,properties={},required=Object.keys(properties),publicRead=false)=>({name,method,path,inputSchema:object(properties,required),public:publicRead});
export const ROUTES=Object.freeze([
 route('auth_challenge','POST','/v1/auth/challenge',{address:string(42)},undefined,true),
 route('auth_session','POST','/v1/auth/session',{challengeId:string(),signature:string(132)},undefined,true),
 route('principal_me','GET','/v1/principals/me'),
 route('project_list','GET','/v1/projects',{after:string(),limit:{type:'integer',minimum:1,maximum:100}},[]),
 route('project_create','POST','/v1/projects',{slug:string(63),name:string(80),idempotencyKey:string()}),
 route('project_get','GET','/v1/projects/{projectId}',{projectId:string()}),
 route('agent_create','POST','/v1/projects/{projectId}/agents',{projectId:string(),name:string(80)}),
 route('mandate_create','POST','/v1/projects/{projectId}/mandates',{projectId:string(),principalId:string(),scopes:{type:'array',items:string(),minItems:1,maxItems:32},expiresAt:integer}),
 route('mandate_revoke','DELETE','/v1/mandates/{mandateId}',{mandateId:string()}),
 route('credential_create','POST','/v1/credentials',{mandateId:string()}),
 route('credential_rotate','POST','/v1/credentials/{credentialId}/rotate',{credentialId:string()}),
 route('credential_revoke','DELETE','/v1/credentials/{credentialId}',{credentialId:string()}),
 route('snapshot_create','POST','/v1/projects/{projectId}/snapshots',{projectId:string(),files:{type:'array',items:file,minItems:1,maxItems:64},expectedProjectRevision:integer}),
 route('snapshot_get','GET','/v1/projects/{projectId}/snapshots/{snapshotId}',{projectId:string(),snapshotId:string()}),
 route('build_create','POST','/v1/projects/{projectId}/builds',{projectId:string(),snapshotId:string(),entry:string(180),contract:string(128),idempotencyKey:string()}),
 route('build_get','GET','/v1/projects/{projectId}/builds/{buildId}',{projectId:string(),buildId:string()}),
 route('build_artifact','GET','/v1/projects/{projectId}/builds/{buildId}/artifact',{projectId:string(),buildId:string()}),
 route('job_get','GET','/v1/projects/{projectId}/jobs/{jobId}',{projectId:string(),jobId:string()}),
 route('job_cancel','DELETE','/v1/projects/{projectId}/jobs/{jobId}',{projectId:string(),jobId:string()}),
 route('review_create','POST','/v1/projects/{projectId}/reviews',{projectId:string(),buildId:string(),repoUrl:string(240),baseCommit:string(40),idempotencyKey:string()}),
 route('review_pilot_get','GET','/v1/admin/review-pilots/{projectId}',{projectId:string()}),
 route('review_pilot_set','PUT','/v1/admin/review-pilots/{projectId}',{projectId:string(),enabled:boolean,expiresAt:integer,maximumPerReview:string(18),expectedRevision:integer}),
 route('review_get','GET','/v1/projects/{projectId}/reviews/{caseId}',{projectId:string(),caseId:string()}),
 route('review_accept','POST','/v1/projects/{projectId}/reviews/{caseId}/accept',{projectId:string(),caseId:string(),quoteId:string(),idempotencyKey:string()}),
 route('review_artifact','GET','/v1/projects/{projectId}/reviews/{caseId}/artifact',{projectId:string(),caseId:string()}),
 route('review_publish','PUT','/v1/projects/{projectId}/reviews/{caseId}/publication',{projectId:string(),caseId:string(),published:boolean,expectedRevision:integer}),
 route('module_deploy','POST','/v1/projects/{projectId}/modules',{projectId:string(),caseId:string()}),
 route('module_get','GET','/v1/projects/{projectId}/modules/{moduleId}',{projectId:string(),moduleId:string()}),
 route('registration_prepare','POST','/v1/projects/{projectId}/chain/registrations/prepare',{projectId:string(),moduleId:string(),configuration:string(16386),mandateId:string(),minDelaySeconds:{type:'integer',minimum:3600,maximum:432000}}),
 route('registration_submit','POST','/v1/projects/{projectId}/chain/registrations/{registrationId}/submit',{projectId:string(),registrationId:string(),signature:string(132)}),
 route('registration_get','GET','/v1/projects/{projectId}/chain/registrations/{registrationId}',{projectId:string(),registrationId:string()}),
 route('chain_binding','GET','/v1/projects/{projectId}/chain',{projectId:string()}),
 route('proposal_create','POST','/v1/projects/{projectId}/proposals',{projectId:string(),moduleId:string(),configuration:string(16386),
  dependencies:{type:'array',maxItems:8,items:object({address:string(42),callData:string(8194)})},idempotencyKey:string()},
  ['projectId','moduleId','configuration','idempotencyKey']),
 route('proposal_get','GET','/v1/projects/{projectId}/proposals/{proposalId}',{projectId:string(),proposalId:string()}),
 route('proposal_publish','PUT','/v1/projects/{projectId}/proposals/{proposalId}/publication',{projectId:string(),proposalId:string(),published:boolean,expectedRevision:integer}),
 route('service_register','POST','/v1/projects/{projectId}/services',{projectId:string(),manifest:object({name:string(80),capability:string(64),version:string(20),inputSchema:true,outputSchema:true,priceWei:string(30),recipient:string(42),maxDurationSeconds:{type:'integer',minimum:30,maximum:3600},validUntil:integer,dataPolicy:string(32)})}),
 route('service_get','GET','/v1/projects/{projectId}/services/{serviceId}',{projectId:string(),serviceId:string()}),
 route('service_publish','PUT','/v1/projects/{projectId}/services/{serviceId}/publication',{projectId:string(),serviceId:string(),published:boolean,expectedRevision:integer}),
 route('service_suspend','POST','/v1/projects/{projectId}/services/{serviceId}/suspend',{projectId:string(),serviceId:string()}),
 route('service_catalog','GET','/v1/public/services',{after:string(),limit:{type:'integer',minimum:1,maximum:100}},[],true),
 route('service_quote','POST','/v1/projects/{projectId}/service-quotes',{projectId:string(),serviceId:string(),input:true,idempotencyKey:string()}),
 route('service_accept','POST','/v1/projects/{projectId}/service-orders',{projectId:string(),quoteId:string()}),
 route('service_order','GET','/v1/projects/{projectId}/service-orders/{orderId}',{projectId:string(),orderId:string()}),
 route('service_authorize','POST','/v1/projects/{projectId}/service-orders/{orderId}/authorization',{projectId:string(),orderId:string(),quoteHash:string()}),
 route('service_cancel','DELETE','/v1/projects/{projectId}/service-orders/{orderId}',{projectId:string(),orderId:string()}),
 route('service_result','GET','/v1/projects/{projectId}/service-orders/{orderId}/result',{projectId:string(),orderId:string()}),
 route('service_accept_result','POST','/v1/projects/{projectId}/service-orders/{orderId}/acceptance',{projectId:string(),orderId:string(),outputHash:string(),accepted:boolean}),
 route('provider_orders','GET','/v1/projects/{projectId}/service-assignments',{projectId:string(),after:string(),limit:{type:'integer',minimum:1,maximum:100}},['projectId']),
 route('provider_claim','POST','/v1/projects/{projectId}/service-assignments/{orderId}/claim',{projectId:string(),orderId:string()}),
 route('provider_deliver','PUT','/v1/projects/{projectId}/service-assignments/{orderId}/delivery',{projectId:string(),orderId:string(),lease:string(64),output:true}),
 route('wallet_create','POST','/v1/projects/{projectId}/wallet',{projectId:string()}),
 route('wallet_get','GET','/v1/projects/{projectId}/wallet',{projectId:string()}),
 route('wallet_action','GET','/v1/projects/{projectId}/wallet/actions/{actionId}',{projectId:string(),actionId:string()}),
 route('wallet_session_prepare','POST','/v1/projects/{projectId}/wallet/sessions/prepare',{projectId:string(),session:object({sessionId:string(66),signer:string(42),recipient:string(42),perPayment:string(30),total:string(30),validUntil:integer})}),
 route('wallet_session_submit','POST','/v1/projects/{projectId}/wallet/sessions/{sessionId}/submit',{projectId:string(),sessionId:string(),signature:string(132)}),
 route('wallet_session_revoke','POST','/v1/projects/{projectId}/wallet/sessions/{sessionId}/revoke-transaction',{projectId:string(),sessionId:string(66)}),
 route('wallet_payment_prepare','POST','/v1/projects/{projectId}/wallet/payments/prepare',{projectId:string(),orderId:string(),sessionId:string(66)}),
 route('wallet_payment_submit','POST','/v1/projects/{projectId}/wallet/payments/{paymentId}/submit',{projectId:string(),paymentId:string(),signature:string(132)}),
 route('vault_create','POST','/v1/projects/{projectId}/vault',{projectId:string()}),
 route('vault_get','GET','/v1/projects/{projectId}/vault',{projectId:string()}),
 route('vault_transaction','POST','/v1/projects/{projectId}/vault/transaction',{projectId:string(),kind:string(12),amountWei:string(78),recipient:string(42)},['projectId','kind','amountWei']),
 route('vault_balance','GET','/v1/projects/{projectId}/vault/balance',{projectId:string(),account:string(42)}),
 route('contract_binding_create','POST','/v1/projects/{projectId}/contract-bindings',{projectId:string(),requester:string(42),expiresAt:integer,maxRequests:{type:'integer',minimum:1,maximum:100},idempotencyKey:string()}),
 route('contract_binding_get','GET','/v1/projects/{projectId}/contract-bindings/{bindingId}',{projectId:string(),bindingId:string()}),
 route('contract_binding_revoke','DELETE','/v1/projects/{projectId}/contract-bindings/{bindingId}',{projectId:string(),bindingId:string()}),
 route('contract_request_get','GET','/v1/projects/{projectId}/contract-requests/{requestId}',{projectId:string(),requestId:string()}),
 route('inference_profile_set','PUT','/v1/admin/inference/profiles',{profile:object({
  id:string(),version:string(),enabled:boolean,providerId:string(),accountId:string(),model:string(),
  providers:{type:'array',items:string(),minItems:1,maxItems:32},asset:string(),fundingAccount:string(),
  permissionHash:string(71),dataPolicyHash:string(71),expiresAt:integer,maximumPerRequest:string(78),
  maxInputBytes:{type:'integer',minimum:1,maximum:65536},maxOutputTokens:{type:'integer',minimum:1,maximum:16384}}),expectedRevision:integer}),
 route('inference_allowance_set','PUT','/v1/admin/inference/allowances/{projectId}',{projectId:string(),profileId:string(),enabled:boolean,expiresAt:integer,limit:string(78),expectedRevision:integer}),
 route('inference_profile','GET','/v1/projects/{projectId}/inference/profiles/{profileId}',{projectId:string(),profileId:string()}),
 route('inference_submit','POST','/v1/projects/{projectId}/inference/requests',{projectId:string(),profileId:string(),profileHash:string(71),model:string(),input:string(65536),maxOutputTokens:{type:'integer',minimum:1,maximum:16384},idempotencyKey:string()}),
 route('inference_get','GET','/v1/projects/{projectId}/inference/requests/{requestId}',{projectId:string(),requestId:string()}),
 route('inference_output','GET','/v1/projects/{projectId}/inference/requests/{requestId}/output',{projectId:string(),requestId:string()}),
 route('inference_cancel','DELETE','/v1/projects/{projectId}/inference/requests/{requestId}',{projectId:string(),requestId:string()}),
 route('release_create','POST','/v1/projects/{projectId}/releases',{projectId:string(),snapshotId:string(),paths:{type:'array',items:string(180),minItems:1,maxItems:32}}),
 route('release_get','GET','/v1/projects/{projectId}/releases/{releaseId}',{projectId:string(),releaseId:string()}),
 route('release_publish','PUT','/v1/projects/{projectId}/releases/{releaseId}/publication',{projectId:string(),releaseId:string(),published:boolean,expiresAt:integer,expectedRevision:integer}),
 route('public_release','GET','/v1/public/releases/{releaseId}',{releaseId:string()},undefined,true),
 route('source_publish','PUT','/v1/projects/{projectId}/sources/{snapshotId}/publication',{projectId:string(),snapshotId:string(),published:boolean,expectedRevision:integer}),
 route('project_publish','PUT','/v1/projects/{projectId}/publication',{projectId:string(),published:boolean,expectedRevision:integer,description:{type:'string',maxLength:500}},['projectId','published','expectedRevision']),
 route('project_export','POST','/v1/projects/{projectId}/exports',{projectId:string(),snapshotId:string()}),
 route('project_transfer_prepare','POST','/v1/projects/{projectId}/transfers',{projectId:string(),destination:string(256),expectedProjectRevision:integer,idempotencyKey:string()}),
 route('project_transfer_page','GET','/v1/projects/{projectId}/transfers/{archiveId}/pages/{page}',{projectId:string(),archiveId:string(),page:integer}),
 route('project_import_begin','POST','/v1/imports',{header:true}),
 route('project_import_page','PUT','/v1/imports/{archiveId}/pages/{page}',{archiveId:string(),page:integer,records:{type:'array',minItems:1,maxItems:100,items:true}}),
 route('project_import_commit','POST','/v1/imports/{archiveId}/commit',{archiveId:string()}),
 route('project_import_history','GET','/v1/projects/{projectId}/import-history',{projectId:string(),page:integer},['projectId']),
 route('public_project','GET','/v1/public/projects/{slug}',{slug:string(63)},undefined,true),
 route('public_source','GET','/v1/public/sources/{sourceId}',{sourceId:string()},undefined,true),
 route('network_graph','GET','/v1/public/graph',{after:string(),limit:{type:'integer',minimum:1,maximum:100}},[],true)
]);
export function validate(schema,value,path='input'){
 if(schema===true)return;
 if(schema.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(Error('invalid_input'),{code:'invalid_input',field:path});
  for(const key of Object.keys(value))if(!Object.hasOwn(schema.properties,key))throw Object.assign(Error('unknown_field'),{code:'invalid_input',field:path+'.'+key});
  for(const key of schema.required??[])if(!Object.hasOwn(value,key))throw Object.assign(Error('missing_field'),{code:'invalid_input',field:path+'.'+key});
  for(const [key,item] of Object.entries(value))validate(schema.properties[key],item,path+'.'+key);
 }else if(schema.type==='array'){
  if(!Array.isArray(value)||value.length<(schema.minItems??0)||value.length>(schema.maxItems??1000))throw Object.assign(Error('invalid_array'),{code:'invalid_input',field:path});
  value.forEach((item,index)=>validate(schema.items,item,path+'.'+index));
 }else if(schema.type==='string'){
  if(typeof value!=='string'||value.length<(schema.minLength??0)||value.length>(schema.maxLength??65536))throw Object.assign(Error('invalid_string'),{code:'invalid_input',field:path});
 }else if(schema.type==='integer'){
  if(!Number.isSafeInteger(value)||value<(schema.minimum??0)||value>(schema.maximum??Number.MAX_SAFE_INTEGER))throw Object.assign(Error('invalid_integer'),{code:'invalid_input',field:path});
 }else if(schema.type==='boolean'&&typeof value!=='boolean')throw Object.assign(Error('invalid_boolean'),{code:'invalid_input',field:path});
}
export function openapi({origin,version=API_VERSION}){
 const paths={};
 for(const r of ROUTES){
  const pathNames=[...r.path.matchAll(/\{(\w+)\}/g)].map(x=>x[1]);
  const parameters=pathNames.map(name=>({name,in:'path',required:true,schema:r.inputSchema.properties[name]}));
  const bodyProperties=Object.fromEntries(Object.entries(r.inputSchema.properties).filter(([k])=>!pathNames.includes(k)));
  const required=r.inputSchema.required.filter(k=>!pathNames.includes(k));
  if(r.method==='GET')parameters.push(...Object.entries(bodyProperties).map(([name,schema])=>({name,in:'query',required:required.includes(name),schema})));
  const item={operationId:r.name,security:r.public?[]:[{bearerAuth:[]}],parameters,responses:{'200':{description:'Operation result'},'400':{description:'Invalid request'},'401':{description:'Credential required'},'403':{description:'Scope denied'},'409':{description:'Revision or idempotency conflict'}}};
  if(r.method!=='GET'&&Object.keys(bodyProperties).length)item.requestBody={required:true,content:{'application/json':{schema:object(bodyProperties,required)}}};
  (paths[r.path]??={})[r.method.toLowerCase()]=item;
 }
 return {openapi:'3.1.0',info:{title:'Claus Network',version},servers:[{url:origin}],paths,components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer',description:'Project-scoped credentials from an owner-authorized mandate.'}}}};
}
