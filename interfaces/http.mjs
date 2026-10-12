import {openapi} from './contract.mjs';
const errors={unauthenticated:401,invalid_signature:401,challenge_expired:401,scope_denied:403,access_denied:403,not_found:404,revision_conflict:409,idempotency_conflict:409,slug_taken:409,rate_limited:429,capacity_reached:429,build_in_progress:409,build_not_complete:409,entry_missing:400,effect_requires_reconciliation:409,job_terminal:409,capability_not_available:503,
 sponsor_not_enabled:403,sponsor_limit:403,review_in_progress:409,source_not_published:409,unsupported_source_host:400,quote_not_ready:409,review_not_complete:409,quote_expired:409,quote_input_mismatch:409,quote_already_admitted:409,provider_offer_already_admitted:409,funding_insufficient:409,
 unsupported_module:400,unsupported_delay:400,unsupported_profile:400,module_not_verified:409,project_not_registered:409,
 project_already_registered:409,registration_expired:409,proposal_in_progress:409,decision_not_complete:409,review_context_too_large:413,chain_not_enabled:409};
export const errorStatus=error=>errors[error.code]??(/^(invalid_|unknown_|missing_|duplicate_|value_|file_|snapshot_|document_)/.test(error.code??'')?400:503);
export const errorBody=error=>({error:error.code&&errorStatus(error)!==503?error.code:'service_unavailable',retryable:errorStatus(error)>=500,
 ...(errorStatus(error)===400&&typeof error.field==='string'&&error.field.length<200?{field:error.field}:{})});
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
   for(let i=0;i<matched.names.length;i++)input[matched.names[i]]=decodeURIComponent(match[i+1]);
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
  }catch(error){const status=errorStatus(error);return json(errorBody(error),status,status===401?{'www-authenticate':'Bearer realm="Claus Network"'}:{});}
 };
}
