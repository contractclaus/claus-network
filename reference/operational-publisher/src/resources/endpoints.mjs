import {digest,sameValue} from './store.mjs';
import {endpointTransport,endpointUrl} from './endpoint-transport.mjs';
import {retryTime} from './providers.mjs';
const fail=c=>{throw Error('resource_endpoint_'+c);};
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const text=(v,max)=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!/-----BEGIN|Bearer\s|(?:token|secret|password|api[-_]?key)\s*[=:]\s*\S{8}/i.test(v);
const keys=(v,allowed)=>object(v)&&Object.keys(v).every(k=>allowed.includes(k)&&!['__proto__','prototype','constructor'].includes(k));
export const endpointInputs={endpoint_create:['name','purpose','definition'],endpoint_update:['resourceId','expectedRevision','definition'],endpoint_disable:['resourceId','expectedRevision'],endpoint_info:['resourceId'],endpoint_invoke:['resourceId','revision','arguments'],endpoint_result:['resourceId','actionId','offset'],endpoint_reconcile:['resourceId','actionId']};
export function validateEndpointSchema(s,depth=0){
 if(depth>8||!keys(s,['type','properties','required','additionalProperties','items','maxItems','maxLength','minimum','maximum','enum'])||!['object','array','string','number','integer','boolean','null'].includes(s.type))fail('schema_invalid');
 if(s.type==='object'){
  if(!object(s.properties)||Object.keys(s.properties).length>50||s.additionalProperties!==false||!Array.isArray(s.required)||s.required.some(k=>!Object.hasOwn(s.properties,k)))fail('schema_invalid');
  for(const [k,v]of Object.entries(s.properties)){if(!/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(k)||['__proto__','prototype','constructor'].includes(k))fail('schema_invalid');validateEndpointSchema(v,depth+1);}
 }else if(s.type==='array'){if(!integer(s.maxItems,0,10000))fail('schema_invalid');validateEndpointSchema(s.items,depth+1);}
 else if(s.type==='string'&&!integer(s.maxLength,1,1000000))fail('schema_invalid');
 if(['number','integer'].includes(s.type)&&(!Number.isFinite(s.minimum)||!Number.isFinite(s.maximum)||s.minimum>s.maximum))fail('schema_invalid');
 if(s.enum!==undefined&&(!Array.isArray(s.enum)||!s.enum.length||s.enum.length>100||s.enum.some(v=>v!==null&&typeof v==='object')))fail('schema_invalid');return s;
}
export function endpointArguments(schema,value){
 if(schema.enum&&!schema.enum.some(v=>v===value))fail('arguments_invalid');
 switch(schema.type){
  case'object':if(!object(value)||Object.keys(value).some(k=>!Object.hasOwn(schema.properties,k))||schema.required.some(k=>!Object.hasOwn(value,k)))fail('arguments_invalid');for(const[k,v]of Object.entries(value))endpointArguments(schema.properties[k],v);break;
  case'array':if(!Array.isArray(value)||value.length>schema.maxItems)fail('arguments_invalid');for(const v of value)endpointArguments(schema.items,v);break;
  case'string':if(typeof value!=='string'||value.length>schema.maxLength)fail('arguments_invalid');break;
  case'number':case'integer':if(typeof value!=='number'||!Number.isFinite(value)||schema.type==='integer'&&!Number.isSafeInteger(value)||value<schema.minimum||value>schema.maximum)fail('arguments_invalid');break;
  case'boolean':if(typeof value!=='boolean')fail('arguments_invalid');break;
  case'null':if(value!==null)fail('arguments_invalid');break;
 }return value;
}
export function validateEndpoint(d){
 if(!keys(d,['url','method','provider','documentation','dataRegion','exitPlan','pricingEvidence','maximumMicroUsd','timeoutSeconds','maximumResponseBytes','inputSchema','auth','idempotencyHeader','expiresAt','capabilities'])||!['GET','POST'].includes(d.method)||!text(d.provider,100)||!text(d.dataRegion,200)||!text(d.exitPlan,1000)||!text(d.pricingEvidence,1500)||!integer(d.timeoutSeconds,1,60)||!integer(d.maximumResponseBytes,1,1000000)||! /^(?:0|[1-9][0-9]{0,8})$/.test(d.maximumMicroUsd??'')||BigInt(d.maximumMicroUsd)>200000000n)fail('definition_invalid');
 endpointUrl(d.url);endpointUrl(d.documentation);validateEndpointSchema(d.inputSchema);if(d.inputSchema.type!=='object')fail('schema_invalid');
 if(d.method==='GET'&&Object.keys(d.inputSchema.properties).length)fail('get_arguments_unsupported');
 if(d.auth!==null&&(!keys(d.auth,['secretId','version','header','scheme'])||!/^sec_[a-f0-9]{24}$/.test(d.auth.secretId??'')||!integer(d.auth.version,1,1000000)||!['authorization','x-api-key','api-key'].includes(d.auth.header)||!['Bearer','raw'].includes(d.auth.scheme)))fail('auth_invalid');
 if(d.idempotencyHeader!==null&&(!/^[a-z][a-z0-9-]{0,70}$/.test(d.idempotencyHeader??'')||!['idempotency-key','x-idempotency-key','x-request-id'].includes(d.idempotencyHeader)))fail('idempotency_header_invalid');
 if(d.expiresAt!==null&&!Number.isFinite(Date.parse(d.expiresAt)))fail('expiry_invalid');
 if(!Array.isArray(d.capabilities)||d.capabilities.length>30||d.capabilities.some(v=>!text(v,100)))fail('capabilities_invalid');return d;
}
export function managedEndpoints({store,budget,seal,open,now=Date.now,workStatus=async()=>null,transport=endpointTransport()}){
 const stamp=()=>new Date(now()).toISOString();
 async function resource(id){const r=await store.get('resource',id);if(!r||r.provider!=='http')fail('resource_invalid');return r;}
 async function auth(d){if(!d.auth)return null;const s=await store.get('secret',d.auth.secretId);if(!s||!['application','external-service'].includes(s.kind)||s.version!==d.auth.version||s.status!=='active'||s.expiresAt&&Date.parse(s.expiresAt)<=now())fail('secret_inactive');return open(s.sealed,s.id+':'+s.version);}
 async function authorized(delegation,operation,r){
  if(!delegation)return;
  if(!['endpoint_info','endpoint_invoke','endpoint_result'].includes(operation))fail('grant_scope_denied');
  const s=await store.get('secret',delegation.id);
  if(!s||s.kind!=='broker-grant'||s.status!=='active'||s.version!==delegation.version||!s.expiresAt||Date.parse(s.expiresAt)<=now())fail('grant_inactive');
  if(!s.rules?.operations?.includes(operation)||!s.rules.resourceIds?.includes(r.id)||operation==='endpoint_invoke'&&r.definition.auth&&!s.rules.secretIds?.includes(r.definition.auth.secretId))fail('grant_scope_denied');
  if(!['ready','working','waiting'].includes(await workStatus(s.rules.workId)))fail('grant_work_inactive');
 }
 async function result(r,id,offset=0,principal='owner'){

  if(!/^act_[a-f0-9]{24}$/.test(id??'')||!integer(offset,0,1000000))fail('receipt_invalid');const row=await store.get('endpoint-response',id);if(!row||row.resourceId!==r.id||principal!=='owner'&&(row.principal??'owner')!==principal)fail('receipt_unknown');
  const raw=open(row.sealed,id),end=Math.min(raw.length,offset+24000);if(offset>raw.length)fail('offset_invalid');
  return {resourceId:r.id,actionId:id,revision:row.endpointRevision,state:'response_received',httpStatus:row.status,successful:row.status>=200&&row.status<300,type:row.type,observedAt:row.at,retryAt:row.retryAt,text:raw.slice(offset,end),offset,nextOffset:end<raw.length?end:null,totalChars:raw.length,responseSha256:row.digest,maximumMicroUsd:row.maximum,instructionAuthority:false};
 }
 return {async call(operation,input,requestId,delegation=null){
  const principal=delegation?.id??'owner';
  if(delegation)await authorized(delegation,operation,await resource(input.resourceId));
  if(operation==='endpoint_info')return {resource:await resource(input.resourceId),...(delegation?{budget:await store.grantBudget(principal)}:{}),capabilityIsNotExecutionProof:true};
  if(operation==='endpoint_result')return result(await resource(input.resourceId),input.actionId,input.offset,principal);
  if(operation==='endpoint_reconcile'){
   if(delegation)fail('grant_scope_denied');
   if(!/^act_[a-f0-9]{24}$/.test(input.actionId??''))fail('receipt_invalid');
   const a=await store.get('action',input.actionId),r=a?.prepared?.resource;
   if(a?.operation!=='endpoint_invoke'||r?.id!==input.resourceId)fail('receipt_unknown');
   if(a.output)return a.output;
   if(!await store.get('endpoint-response',input.actionId))return {id:input.actionId,resourceId:r.id,state:'outcome_unknown',retry:false,next:'No saved response. Inspect the original provider request; all holds remain.'};
   if(r.definition.maximumMicroUsd!=='0')await budget('commit',input.actionId,r.definition.maximumMicroUsd,'service');
   return store.complete(input.actionId,{id:input.actionId,...await result(r,input.actionId)});
  }
  if(typeof requestId!=='string'||!requestId||requestId.length>200)fail('request_invalid');const id='act_'+digest([principal,requestId]).slice(0,24),old=await store.get('action',id);
  if(old&&(old.operation!==operation||!sameValue(old.input,input)))fail('request_conflict');if(old?.output)return old.output;
  let prepared=old?.prepared;
  if(!prepared){
   if(operation==='endpoint_create'){
    if(!/^[a-z][a-z0-9-]{1,40}$/.test(input.name??'')||!text(input.purpose,350))fail('name_invalid');
    const d=validateEndpoint(input.definition);await auth(d);prepared={id:'res_'+digest(id).slice(0,24),name:input.name,purpose:input.purpose,provider:'http',providerId:d.url,url:d.url,owner:'Claus',kind:'managed-service-endpoint',status:'active',revision:1,definition:d,createdAt:stamp(),creationAction:id,lastAction:id};
   }else{
    const r=await resource(input.resourceId);
    if(operation==='endpoint_invoke'){
     if(r.status!=='active'||r.revision!==input.revision||r.definition.expiresAt&&Date.parse(r.definition.expiresAt)<=now())fail('endpoint_inactive');
     const d=validateEndpoint(r.definition);endpointArguments(d.inputSchema,input.arguments);if(Buffer.byteLength(JSON.stringify(input.arguments))>1000000)fail('arguments_size');await auth(d);prepared={resource:r,principal};
    }else if(['endpoint_update','endpoint_disable'].includes(operation)){
     if(r.revision!==input.expectedRevision)fail('revision_conflict');const d=operation==='endpoint_update'?validateEndpoint(input.definition):r.definition;if(operation==='endpoint_update')await auth(d);
     prepared={...r,definition:d,providerId:d.url,url:d.url,status:operation==='endpoint_disable'?'disabled':'active',revision:r.revision+1,lastAction:id,updatedAt:stamp()};
    }else fail('operation_invalid');
   }
   prepared=(await store.begin(id,operation,input,prepared)).row.result.prepared;
  }
  const complete=value=>store.complete(id,{id,...value});
  if(operation==='endpoint_create'){const saved=await store.put('resource',prepared.id,prepared);await store.put('endpoint-version',prepared.id+':1',prepared);return complete({resource:saved.value,invoked:false});}
  if(operation==='endpoint_update'||operation==='endpoint_disable'){
   const current=await resource(prepared.id);if(current.lastAction!==id)await store.change('resource',current.id,prepared.revision-1,prepared);
   await store.put('endpoint-version',prepared.id+':'+prepared.revision,prepared);return complete({resource:prepared,invoked:false});
  }
  const r=prepared.resource,d=r.definition,maximum=d.maximumMicroUsd;
  const finish=async()=>{if(maximum!=='0')await budget('commit',id,maximum,'service');return complete(await result(r,id,0,principal));};
  if(await store.get('endpoint-response',id))return finish();
  const current=await resource(r.id);if(current.status!=='active'||current.revision!==r.revision||d.expiresAt&&Date.parse(d.expiresAt)<=now())fail('endpoint_inactive');
  const key=await auth(d),spend=delegation?{grantId:principal,version:delegation.version,actionId:id,resourceId:r.id,secretId:d.auth?.secretId??null,maximum}:null;
  if(spend){await authorized(delegation,operation,r);await store.reserveGrant(spend);}
  try{if(maximum!=='0')await budget('reserve',id,maximum,'service');}
  catch(error){if(spend)await store.releaseGrant(spend);throw error;}
  if(spend)await authorized(delegation,operation,r);
  if(!(spend?await store.dispatchGrant(spend):await store.dispatch(id)))return {id,resourceId:r.id,state:'outcome_unknown',retry:false,maximumMicroUsd:maximum,next:'Reconcile the provider using this action ID. The original request is not resent; reserved cost stays held.'};
  let response;
  try{
   const headers={...(key?{[d.auth.header]:(d.auth.scheme==='Bearer'?'Bearer ':'')+key}:{}),...(d.idempotencyHeader?{[d.idempotencyHeader]:id}:{})};
   response=await transport({url:d.url,method:d.method,headers,body:d.method==='POST'?JSON.stringify(input.arguments):undefined,timeoutSeconds:d.timeoutSeconds,maximumBytes:d.maximumResponseBytes});
  }catch(error){return {id,resourceId:r.id,error:/^resource_endpoint_[a-z_]+$/.test(error?.message??'')?error.message:'resource_endpoint_transport_unavailable',state:'outcome_unknown',retry:false,maximumMicroUsd:maximum,next:'Inspect the original provider request before any new invocation. Transport failure does not prove nonexecution or nonpayment.'};}
  const redact=v=>{
   if(Array.isArray(v))return v.map(redact);
   if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,value])=>[k,/(?:^|_)(?:api_?key|access_?token|refresh_?token|secret|password|cookie|authorization|private_?key)(?:$|_)/i.test(k)?'[redacted]':redact(value)]));
   return typeof v==='string'?(key?v.split(key).join('[redacted]'):v).replace(/Bearer\s+[A-Za-z0-9_.~+\/-]+/gi,'Bearer [redacted]'):v;
  };
  let safe;try{safe=JSON.stringify(redact(JSON.parse(response.text)));}catch{safe=redact(response.text);}
  const retryAt=retryTime(response.retryAfter,now());
  await store.put('endpoint-response',id,{resourceId:r.id,principal,endpointRevision:r.revision,status:response.status,type:response.type,at:stamp(),retryAt:retryAt?new Date(retryAt).toISOString():null,maximum,digest:digest(safe),sealed:seal(safe,id)});
  return finish();
 }};
}
