export const API_VERSION='0.11.3';
const string=(maxLength=256)=>({type:'string',minLength:1,maxLength});
const integer={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER};
const boolean={type:'boolean'};
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const file=object({path:string(180),content:{type:'string',maxLength:48000}});
const descriptions = {
 agent_publish: 'Explicitly publish or withdraw one agent name. Requires project.publish and expectedRevision; other identities stay private.',
 review_admission_get: 'Read sponsored-review rules and lifetime committed maximum. Network owner session only.',
 review_admission_publish: 'Store immutable bounded sponsored-review rules. Network owner session only. Does not fund or activate spending.',
 review_admission_activate: 'Activate review rules by expectedGeneration. Network owner only. Existing exposure and reservations are preserved; funding remains necessary.',
 capabilities: 'Discover current admission, supported profiles and technical limits. Public read; no rights or credits are granted.',
 project_capabilities: 'Read own project rights and remaining local quotas. Requires project.read. Funding and chain checks remain separate.',
 identity_list: 'Recover project agents, mandates or credential metadata. Owner session required. No credential secrets are returned.',
 resource_list: 'Recover own resource IDs after restart. Requires the corresponding resource read scope; follow nextCursor until null.',
 access_policy_get: 'Read the active nonfinancial access policy. Network owner session required.',
 access_policy_publish: 'Store an immutable nonfinancial policy version. Network owner only. Does not activate it; same version and content are idempotent.',
 access_policy_activate: 'Activate a published nonfinancial policy using expectedGeneration. Network owner only. Existing usage is never reset.',
 project_access_set: 'Suspend or resume new project effects using expectedRevision. Network owner only. Reads, revocation and exits remain available.',
 auth_challenge: 'Request a five-minute EOA login message. Sign it locally; this authorizes login, not an onchain transaction.',
 auth_session: 'Exchange a one-use signed challenge for a private owner session. Store securely; never send the result into model context.',
 project_create: 'Create a private project. Owner session required. Retry only with the same idempotencyKey and identical input.',
 agent_create: 'Create an agent identity in own project. Owner only. Use idempotencyKey for lost-response recovery; identity_list recovers IDs.',
 mandate_create: 'Authorize explicit project scopes and expiry for an agent. Owner only. Reuse idempotencyKey; revocation never creates replacement rights.',
 credential_create: 'Issue a one-time secret for an active mandate. Owner only. Lost response: revoke mandate and issue a new grant; secret is not retrievable.',
 credential_rotate: 'Rotate a credential, retiring the old token. Lost response: owner revokes the mandate and creates a fresh grant.',
 snapshot_create: 'Store a bounded private text snapshot. Requires snapshot.create and expectedProjectRevision. Does not run or publish any file.',
 service_register: 'Register an immutable service manifest. Requires service.manage. Host creates an unpaid transport probe before availability.',
 service_accept: 'Accept exact unexpired quote with service.call. Zero-price quotes need no payment; paid quotes await independent receipt verification. Same quoteId recovers order.',
 release_create: 'Select static files from own snapshot with release.publish and artifact.read. Does not publish the UI or expose other snapshot files.',
 release_publish: 'Publish, renew or withdraw isolated static UI using expectedRevision. Requires release.publish. No backend or private API access is granted.',
 project_publish: 'Explicitly publish or withdraw a project profile using expectedRevision. Requires project.publish; private files and agents stay private.',
 project_export: 'Export own selected snapshot and files. Requires project.export and artifact.read. No side effects or destination operator needed.'
};
const route=(name,method,path,properties={},required=Object.keys(properties),publicRead=false)=>({name,method,path,inputSchema:object(properties,required),public:publicRead,
 description:descriptions[name] ?? `${method} ${path}. ${publicRead?'Public read.':method==='GET'?'Requires current object read permission.':'Requires current object mutation permission. Reconcile existing resource IDs before retrying an uncertain request.'}`});
export const ROUTES=Object.freeze([
 route('capabilities','GET','/v1/public/capabilities',{},[],true),
 route('project_capabilities','GET','/v1/projects/{projectId}/capabilities',{projectId:string()}),
 route('identity_list','GET','/v1/projects/{projectId}/access/{kind}',{projectId:string(),kind:{type:'string',enum:['agents','mandates','credentials']},after:string(),limit:{type:'integer',minimum:1,maximum:100}},['projectId','kind']),
 route('resource_list','GET','/v1/projects/{projectId}/resources/{kind}',{projectId:string(),kind:{type:'string',enum:['snapshots','builds','jobs','reviews','proposals','services','orders','releases','bindings','requests']},after:string(),limit:{type:'integer',minimum:1,maximum:100}},['projectId','kind']),
 route('access_policy_get','GET','/v1/admin/access-policy'),
 route('access_policy_publish','POST','/v1/admin/access-policy/versions',{version:string(64),config:true}),
 route('access_policy_activate','PUT','/v1/admin/access-policy/active',{version:string(64),expectedGeneration:integer}),
 route('project_access_set','PUT','/v1/admin/projects/{projectId}/access',{projectId:string(),suspended:boolean,expectedRevision:integer}),
 route('auth_challenge','POST','/v1/auth/challenge',{address:string(42)},undefined,true),
 route('auth_session','POST','/v1/auth/session',{challengeId:string(),signature:string(132)},undefined,true),
 route('principal_me','GET','/v1/principals/me'),
 route('project_list','GET','/v1/projects',{after:string(),limit:{type:'integer',minimum:1,maximum:100}},[]),
 route('project_create','POST','/v1/projects',{slug:string(63),name:string(80),idempotencyKey:string()}),
 route('project_get','GET','/v1/projects/{projectId}',{projectId:string()}),
 route('agent_create','POST','/v1/projects/{projectId}/agents',{projectId:string(),name:string(80),idempotencyKey:string()},['projectId','name']),
 route('mandate_create','POST','/v1/projects/{projectId}/mandates',{projectId:string(),principalId:string(),scopes:{type:'array',items:string(),minItems:1,maxItems:64},expiresAt:integer,idempotencyKey:string()},['projectId','principalId','scopes','expiresAt']),
 route('mandate_revoke','DELETE','/v1/mandates/{mandateId}',{mandateId:string()}),
 route('credential_create','POST','/v1/credentials',{mandateId:string()}),
 route('credential_rotate','POST','/v1/credentials/{credentialId}/rotate',{credentialId:string()}),
 route('credential_revoke','DELETE','/v1/credentials/{credentialId}',{credentialId:string()}),
 route('snapshot_create','POST','/v1/projects/{projectId}/snapshots',{projectId:string(),files:{type:'array',items:file,minItems:1,maxItems:64},expectedProjectRevision:integer}),
 route('snapshot_get','GET','/v1/projects/{projectId}/snapshots/{snapshotId}',{projectId:string(),snapshotId:string()}),
 route('build_create','POST','/v1/projects/{projectId}/builds',{projectId:string(),snapshotId:string(),entry:string(180),contract:string(128),idempotencyKey:string(),
  compilerProfile:{type:'string',enum:['solidity-static-compile-v1','solidity-0.8.26-static-v1']},sourceRoot:string(160)},['projectId','snapshotId','entry','contract','idempotencyKey']),
 route('build_get','GET','/v1/projects/{projectId}/builds/{buildId}',{projectId:string(),buildId:string()}),
 route('build_artifact','GET','/v1/projects/{projectId}/builds/{buildId}/artifact',{projectId:string(),buildId:string()}),
 route('job_get','GET','/v1/projects/{projectId}/jobs/{jobId}',{projectId:string(),jobId:string()}),
 route('job_cancel','DELETE','/v1/projects/{projectId}/jobs/{jobId}',{projectId:string(),jobId:string()}),
 route('review_admission_get','GET','/v1/admin/review-admission'),
 route('review_admission_publish','POST','/v1/admin/review-admission/versions',{version:string(64),config:object({enabled:boolean,expiresAt:integer,maximumPerReview:string(18),maximumLifetime:string(30),perOwnerDay:integer,perProjectDay:integer,globalDay:integer,activeGlobal:integer})}),
 route('review_admission_activate','PUT','/v1/admin/review-admission/active',{version:string(64),expectedGeneration:integer}),
 route('review_create','POST','/v1/projects/{projectId}/reviews',{projectId:string(),buildId:string(),repoUrl:string(240),baseCommit:string(40),idempotencyKey:string()}),
 route('review_pilot_get','GET','/v1/admin/review-pilots/{projectId}',{projectId:string()}),
 route('review_pilot_set','PUT','/v1/admin/review-pilots/{projectId}',{projectId:string(),enabled:boolean,expiresAt:integer,maximumPerReview:string(18),expectedRevision:integer,perProjectDay:integer,globalDay:integer},['projectId','enabled','expiresAt','maximumPerReview','expectedRevision']),
 route('review_get','GET','/v1/projects/{projectId}/reviews/{caseId}',{projectId:string(),caseId:string()}),
 route('review_accept','POST','/v1/projects/{projectId}/reviews/{caseId}/accept',{projectId:string(),caseId:string(),quoteId:string(),idempotencyKey:string()}),
 route('review_artifact','GET','/v1/projects/{projectId}/reviews/{caseId}/artifact',{projectId:string(),caseId:string()}),
 route('review_publish','PUT','/v1/projects/{projectId}/reviews/{caseId}/publication',{projectId:string(),caseId:string(),published:boolean,expectedRevision:integer}),
 route('chain_admission_get','GET','/v1/admin/chain-admission'),
 route('chain_admission_publish','POST','/v1/admin/chain-admission/versions',{version:string(64),config:object({enabled:boolean,expiresAt:integer,executor:string(42),executorCodeHash:string(66),targetArtifactHash:string(71),reviewProjectId:string(),reviewCaseId:string(),reviewArtifactHash:string(71),maximumProjects:integer,maximumTransactionGasWei:string(30),maximumProjectGasWei:string(30),maximumTotalGasWei:string(30)})}),
 route('chain_admission_activate','PUT','/v1/admin/chain-admission/active',{version:string(64),expectedGeneration:integer}),
 route('module_deploy','POST','/v1/projects/{projectId}/modules',{projectId:string(),caseId:string()}),
 route('module_get','GET','/v1/projects/{projectId}/modules/{moduleId}',{projectId:string(),moduleId:string()}),
 route('registration_prepare','POST','/v1/projects/{projectId}/chain/registrations/prepare',{projectId:string(),moduleId:string(),configuration:string(16386),mandateId:string(),minDelaySeconds:{type:'integer',minimum:0,maximum:432000}}),
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
 route('agent_publish','PUT','/v1/projects/{projectId}/agents/{agentId}/publication',{projectId:string(),agentId:string(),published:boolean,expectedRevision:integer}),
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
 route('public_review','GET','/v1/public/reviews/{caseId}',{caseId:string()},undefined,true),
 route('network_graph','GET','/v1/public/graph',{after:string(),limit:{type:'integer',minimum:1,maximum:100}},[],true)
]);
export function validate(schema,value,path='input'){
 if(schema===true)return;
 if(schema.enum&&!schema.enum.includes(value))throw Object.assign(Error('invalid_choice'),{code:'invalid_input',field:path});
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
  const item={operationId:r.name,description:r.description,security:r.public?[]:[{bearerAuth:[]}],parameters,responses:{'200':{description:'Operation result'},'400':{description:'Invalid request'},'401':{description:'Credential required'},'403':{description:'Scope denied'},'409':{description:'State, funding, revision or idempotency conflict'},'429':{description:'Capacity exceeded; honor Retry-After'},'503':{description:'Service unavailable; reconcile mutations before retrying'}}};
  if(r.method!=='GET'&&Object.keys(bodyProperties).length)item.requestBody={required:true,content:{'application/json':{schema:object(bodyProperties,required)}}};
  (paths[r.path]??={})[r.method.toLowerCase()]=item;
 }
 return {openapi:'3.1.0',info:{title:'Claus Network',version},servers:[{url:origin}],paths,components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer',description:'Project-scoped credentials from an owner-authorized mandate.'}}}};
}
