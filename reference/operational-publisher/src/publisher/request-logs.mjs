const PROJECT='prj_rGom8c2zwC8zztmqsSFPaAJj7fXs',TEAM='team_uolDmrwvORBaI3V7q4JVMKNS';
const FAULT_CODES=new Set(["oci_private_key_unavailable","oci_image_storage_mismatch","oci_image_storage_unavailable","deal_worker_unavailable","invalid_deal_pins","search_admission_unavailable","source_storage_unavailable","_read_unavailable","_write_outcome_unknown","_write_not_visible","artifact_corrupt","capability_not_available","wrong_origin","unexpected_error","ECONNRESET","ECONNREFUSED","ETIMEDOUT","ENOTFOUND","EAI_AGAIN","UND_ERR_CONNECT_TIMEOUT","UND_ERR_HEADERS_TIMEOUT","UND_ERR_SOCKET","08000","08001","08003","08004","08006","08007","08P01","22001","22003","22007","22023","22P02","23502","23503","23505","23514","25006","25P02","40001","40P01","42501","42601","42703","42804","42883","42P01","42P07","53300","53400","55000","55P03","57014","57P01","57P02","57P03","58000","58030"]);
const limited=(value,pattern)=>typeof value==='string'&&pattern.test(value)?value:null;
function route(path){
 if(typeof path!=='string')return null;
 if(['/health','/mcp','/openapi.json'].includes(path))return path;
 const p=path.match(/^\/v1\/projects\/[^/?]+(\/(?:snapshots|builds|resources|records|releases))?(?:\/[^?]*)?$/);
 if(p)return '/v1/projects/{projectId}'+(p[1]??'');
 const pub=path.match(/^\/v1\/public\/(graph|capabilities|apps|projects|sources|services)(?:\/[^?]*)?$/);
 return pub?'/v1/public/'+pub[1]:null;
}
function fault(value){
 if(!value||typeof value!=='object')return null;
 return {code:FAULT_CODES.has(value.code)?value.code:null,name:limited(value.name,/^(?:Error|TypeError|RangeError|SyntaxError|AggregateError|AbortError|TimeoutError)$/),
  frames:Array.isArray(value.frames)?value.frames.slice(0,6).flatMap(f=>limited(f?.file,/^(?:api|runtime|src|interfaces|adapters)\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts)$/)&&!f.file.split('/').includes('..')&&Number.isSafeInteger(f.line)&&Number.isSafeInteger(f.column)?[{file:f.file,line:f.line,column:f.column}]:[]):[]};
}
export function sanitizeRequestLogs(data){
 if(!Array.isArray(data?.rows))throw Error('request_log_response_invalid');
 const items=data.rows.slice(0,50).flatMap(row=>{
  if(row.environment!=='production'||!Number.isSafeInteger(row.statusCode)||(row.statusCode<100||row.statusCode>599))return [];
  const failures=(Array.isArray(row.logs)?row.logs:[]).slice(0,20).flatMap(log=>{
   if(typeof log.message!=='string'||log.message.length>12000)return [];
   let value;try{value=JSON.parse(log.message);}catch{return [];}
   if(value?.type!=='claus.request.failure.v1'||!limited(value.requestId,/^crq_[a-f0-9]{32}$/))return [];
   return [{requestId:value.requestId,status:Number.isSafeInteger(value.status)?value.status:null,
    transport:limited(value.transport,/^(?:http|mcp|gateway)$/),operation:limited(value.operation,/^[a-z_]{1,80}$/),
    phase:limited(value.phase,/^(?:route|admission|decode|execute|bootstrap|read_request|dispatch|send_response)$/),
    originClass:limited(value.originClass,/^(?:none|configured|claus|other)$/),fault:fault(value.fault),cause:fault(value.cause)}];
  });
  if(row.statusCode<500&&!failures.some(f=>f.status>=500||f.fault?.code==='wrong_origin'))return [];
  return [{providerRequestId:limited(row.requestId,/^[A-Za-z0-9:_-]{1,180}$/),at:Number.isFinite(Date.parse(row.timestamp))?new Date(row.timestamp).toISOString():null,
   deployment:limited(row.deploymentId,/^dpl_[A-Za-z0-9]+$/),method:limited(row.requestMethod,/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/),
   route:route(row.requestPath),status:row.statusCode,failures,detailAvailable:failures.length>0}];
 });
 return {items,hasMore:data.hasMoreRows===true||data.rows.length>50};
}

// Fixed owner project and fixed metadata projection. The existing team token
// stays in custody; callers cannot choose a provider URL or another project.
export async function apiRequestDiagnostics({request=fetch,env=process.env,now=Date.now()}={}){
 const token=env.RESOURCE_VERCEL_TOKEN;
 if(!token)return {available:false,reason:'request_logs_not_connected',items:[]};
 const from=now-86400000;
 try{
  const results=await Promise.all([{statusCode:'5xx'},{level:'error'}].map(async filter=>{
   const query=new URLSearchParams({projectId:PROJECT,ownerId:TEAM,page:'0',startDate:String(from),endDate:String(now),environment:'production',...filter});
   const response=await request('https://vercel.com/api/logs/request-logs?'+query,{headers:{authorization:'Bearer '+token,accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(12000)});
   if(!response.ok)throw Error('request_logs_unavailable');
   const reader=response.body.getReader(),chunks=[];let length=0;
   try{for(;;){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>1000000)throw Error('request_log_response_too_large');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   return sanitizeRequestLogs(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }));
  const merged=[...new Map(results.flatMap(r=>r.items).map(x=>[x.providerRequestId??x.failures[0]?.requestId,x])).values()].sort((a,b)=>String(b.at).localeCompare(String(a.at)));
  return {available:true,from:new Date(from).toISOString(),through:new Date(now).toISOString(),items:merged.slice(0,50),hasMore:results.some(r=>r.hasMore)||merged.length>50,
   meaning:'Provider-retained production request metadata and sanitized application failures for the owned Network API. Paths omit project IDs; raw messages, payloads and credentials are excluded. A legacy request without detail does not establish its root cause. Logs can lag or expire; this read never replays an operation.'};
 }catch{return {available:false,reason:'request_logs_unavailable',from:new Date(from).toISOString(),through:new Date(now).toISOString(),items:[]};}
}
