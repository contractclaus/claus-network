import {requestDiagnostics} from './request-diagnostics.mjs';
import {SITE_LIMITS} from '../src/shared/index.mjs';
import {body,errorBody,errorStatus,knownErrorCode} from './http.mjs';
import {API_VERSION} from './contract.mjs';
const VERSION='2025-06-18';
// Credential bootstrap/rotation belongs in a secure client or CLI, not a model
// tool result. The remaining tools call the exact same authorization service.
const SECRET_OPERATIONS=new Set(['auth_session','credential_create','credential_rotate','app_session_create']);
const result=(value,status=200,headers={})=>new Response(value===undefined?null:JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff',...headers}});
const failure=(id,code,message,status=200)=>result({jsonrpc:'2.0',id,error:{code,message}},status);
export function createMcp({service,origin='https://claus.si',admit=async()=>{}}){
 const routes=service.routes.filter(r=>!SECRET_OPERATIONS.has(r.name));
 return async(request,context={})=>{
  const diagnostic=requestDiagnostics(request,{requestId:context.requestId,origin,transport:'mcp'});
  const reply=(value,status=200,headers={})=>result(value,status,{...headers,...diagnostic.headers});
  if(request.headers.get('origin')&&request.headers.get('origin')!==origin){diagnostic.failure({status:403,code:'wrong_origin',route:'/mcp',phase:'route'});return reply({error:'wrong_origin',requestId:diagnostic.id},403);}
  if(request.method!=='POST')return new Response(null,{status:405,headers:{allow:'POST'}});
  if(!request.headers.get('accept')?.includes('application/json')||!request.headers.get('accept')?.includes('text/event-stream'))return result({error:'accept_required'},406);
  let input;
  try{await admit({route:'mcp',peer:context.peer??'unknown'});input=await body(request,SITE_LIMITS.requestBytes);}
  catch(e){const status=errorStatus(e),data={...errorBody(e),requestId:diagnostic.id};diagnostic.failure({status,error:e,code:knownErrorCode(e),route:'/mcp',phase:'admission'});return reply({jsonrpc:'2.0',id:null,error:{code:status===429?-32000:-32700,message:status===429?'Rate limited':'Invalid request',data}},status,status===429?{'retry-after':String(data.retryAfterSeconds)}:{});}
  if(!input||Array.isArray(input)||input.jsonrpc!=='2.0'||typeof input.method!=='string'||Object.keys(input).some(k=>!['jsonrpc','id','method','params'].includes(k)))return failure(null,-32600,'Invalid Request',400);
  if(!['snapshot_create','content_admin_correct'].includes(input.params?.name)&&Buffer.byteLength(JSON.stringify(input))>300000)return failure(input.id??null,-32600,'Request too large',413);
  const id=input.id;
  if(id!==undefined&&typeof id!=='string'&&!(typeof id==='number'&&Number.isSafeInteger(id)))return failure(null,-32600,'Invalid Request',400);
  const params=input.params??{};
  if(typeof params!=='object'||params===null||Array.isArray(params))return failure(id??null,-32602,'Invalid params');
  if(input.method==='initialize')return result({jsonrpc:'2.0',id,result:{protocolVersion:VERSION,capabilities:{tools:{listChanged:false}},serverInfo:{name:'Claus Network',version:API_VERSION}}});
  const protocol=request.headers.get('mcp-protocol-version');
  if(protocol&&protocol!==VERSION)return failure(id??null,-32600,'Unsupported protocol',400);
  if(id===undefined)return result(undefined,202);
  if(input.method==='ping')return result({jsonrpc:'2.0',id,result:{}});
  if(input.method==='tools/list')return result({jsonrpc:'2.0',id,result:{tools:routes.map(r=>({name:r.name,description:r.description ?? r.method+' '+r.path,inputSchema:r.inputSchema,annotations:{readOnlyHint:r.method==='GET',destructiveHint:r.method!=='GET',openWorldHint:true}}))}});
  if(input.method!=='tools/call')return failure(id,-32601,'Method not found');
  if(!routes.some(r=>r.name===params.name))return failure(id,-32602,'Unknown tool');
  const rawToken=request.headers.get('authorization')?.match(/^Bearer (cln_[A-Za-z0-9_-]{43})$/)?.[1];
  try{
   await admit({route:params.name,peer:context.peer??'unknown'});
   const value=await service.execute(params.name,params.arguments??{},rawToken,{signal:request.signal});
   return result({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(value).length>131072?'Large result is provided in structuredContent.':JSON.stringify(value)}],structuredContent:value,isError:false}});
  }catch(error){const data={...errorBody(error),requestId:diagnostic.id};diagnostic.failure({status:errorStatus(error),error,code:knownErrorCode(error),operation:params.name,route:'/mcp',phase:'execute'});return reply({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(data)}],isError:true}},200,data.retryAfterSeconds?{'retry-after':String(data.retryAfterSeconds)}:{});}
 };
}
