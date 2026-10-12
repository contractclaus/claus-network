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
 route('mandate_create','POST','/v1/projects/{projectId}/mandates',{projectId:string(),principalId:string(),scopes:{type:'array',items:string(),minItems:1,maxItems:24},expiresAt:integer}),
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
 route('source_publish','PUT','/v1/projects/{projectId}/sources/{snapshotId}/publication',{projectId:string(),snapshotId:string(),published:boolean,expectedRevision:integer}),
 route('project_publish','PUT','/v1/projects/{projectId}/publication',{projectId:string(),published:boolean,expectedRevision:integer,description:{type:'string',maxLength:500}},['projectId','published','expectedRevision']),
 route('project_export','POST','/v1/projects/{projectId}/exports',{projectId:string(),snapshotId:string()}),
 route('public_project','GET','/v1/public/projects/{slug}',{slug:string(63)},undefined,true),
 route('public_source','GET','/v1/public/sources/{sourceId}',{sourceId:string()},undefined,true),
 route('network_graph','GET','/v1/public/graph',{after:string(),limit:{type:'integer',minimum:1,maximum:100}},[],true)
]);
export function validate(schema,value,path='input'){
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
export function openapi({origin,version='0.3.0'}){
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
