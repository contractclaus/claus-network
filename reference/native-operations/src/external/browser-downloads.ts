import {createHmac,createHash,timingSafeEqual} from 'node:crypto';
import {sql,configuration,ConfirmedFailure} from '../store.js';
import {operationsEnabled} from '../operations/service.js';
import {providerJson,ProviderFailure} from './providers.js';
const validId=(v:any)=>typeof v==='string'&&/^[a-zA-Z0-9_-]{8,150}$/.test(v);
export async function ownedBrowserSession(sessionId:string,principal:string,db:any=sql()){
 if(!validId(sessionId))throw new ConfirmedFailure('browser_session_invalid');
 if(principal!=='claus'){
  const task=(await db`SELECT status,progress FROM claus_actions WHERE id=${principal} AND kind='development'`)[0];
  if(task?.status!=='pending'||!['command_starting','command_running'].includes(task.progress?.execution?.phase)||!(Date.parse(task.progress?.execution?.deadline??'')>Date.now()))throw new ConfirmedFailure('browser_task_not_active');
 }
 const row=(await db`SELECT id,input FROM claus_actions WHERE kind='external_tools' AND status='completed' AND input->>'principal'=${principal} AND input->>'operation' IN ('browser_open','browser_workflow') AND result->>'sessionId'=${sessionId} ORDER BY id LIMIT 1`)[0];
 if(!row)throw new ConfirmedFailure('browser_session_not_owned');
 const input=JSON.parse(row.input.input??'{}');return {actionId:row.id,workId:input.workId??null};
}
const headers=()=>{if(!process.env.BROWSERBASE_API_KEY)throw new ProviderFailure('browser_not_connected',true);return {'X-BB-API-Key':process.env.BROWSERBASE_API_KEY!,Accept:'application/json'};};
const metadata=(v:any,sessionId:string)=>{
 if(!validId(v.id)||v.sessionId!==sessionId||typeof v.filename!=='string'||v.filename.length>255||!Number.isSafeInteger(v.size)||v.size<0||!/^[a-fA-F0-9]{64}$/.test(v.checksum))throw new ProviderFailure('browser_download_metadata_invalid',true);
 return {id:v.id,sessionId,filename:v.filename,mimeType:String(v.mimeType??'application/octet-stream'),size:v.size,checksum:v.checksum.toLowerCase(),createdAt:v.createdAt};
};
export function signBrowserDownload(value:any,key:string){if(key.length<32)throw Error('browser_download_signing_unavailable');const body=Buffer.from(JSON.stringify(value)).toString('base64url');return body+'.'+createHmac('sha256',key).update('browser-download-v1.'+body).digest('base64url');}
export function readBrowserDownload(token:string,key:string,now=Date.now()){
 if(key.length<32||token.length>4000)throw Error('browser_download_grant_invalid');
 const [body,signature,extra]=token.split('.'),expected=createHmac('sha256',key).update('browser-download-v1.'+body).digest();
 const given=Buffer.from(signature??'','base64url');if(extra||given.length!==expected.length||!timingSafeEqual(given,expected))throw Error('browser_download_grant_invalid');
 const v=JSON.parse(Buffer.from(body,'base64url').toString());
 if(v.version!==1||!validId(v.sessionId)||!validId(v.id)||typeof v.principal!=='string'||!Number.isSafeInteger(v.exp)||v.exp<=now||v.exp>now+300000||!Number.isSafeInteger(v.size)||v.size<0||!/^[a-f0-9]{64}$/.test(v.checksum))throw Error('browser_download_grant_invalid');
 return v;
}
export async function browserDownloads(operation:string,input:any,principal:string,db:any=sql()){
 const owner=await ownedBrowserSession(input.sessionId,principal,db);
 if(operation==='browser_downloads'){
  if(Object.keys(input).some(k=>!['sessionId','offset','workId'].includes(k))||!Number.isSafeInteger(input.offset??0)||(input.offset??0)<0)throw new ConfirmedFailure('browser_download_request_invalid');
  const offset=input.offset??0;
  const r=await providerJson('https://api.browserbase.com/v1/downloads?'+new URLSearchParams({sessionId:input.sessionId,limit:'50',offset:String(offset)}),{headers:headers()},true);
  if(!Array.isArray(r.downloads)||!Number.isSafeInteger(r.total))throw new ProviderFailure('browser_download_metadata_invalid',true);
  return {sessionId:input.sessionId,files:r.downloads.map((v:any)=>metadata(v,input.sessionId)),total:r.total,nextOffset:offset+r.downloads.length<r.total?offset+r.downloads.length:null,instructionAuthority:false};
 }
 if(Object.keys(input).some(k=>!['sessionId','downloadId','workId'].includes(k))||!validId(input.downloadId))throw new ConfirmedFailure('browser_download_request_invalid');
 const info=metadata(await providerJson('https://api.browserbase.com/v1/downloads/'+input.downloadId,{headers:headers()},true),input.sessionId);
 const exp=Date.now()+300000;
 const grant=signBrowserDownload({...info,version:1,principal,workId:owner.workId,actionId:owner.actionId,exp},process.env.CLAUS_TOOL_GATEWAY_SECRET??'');
 return {...info,transfer:{url:'https://claus-agent.vercel.app/internal/browser-download',headers:{'x-claus-download-grant':grant},expiresAt:new Date(exp).toISOString()},verification:'Stream to storage and verify byte count and SHA256 before use. This download has not been executed.',instructionAuthority:false};
}
export async function browserDownloadRoute(req:Request):Promise<Response>{
 let grant:any;
 try{
  grant=readBrowserDownload(req.headers.get('x-claus-download-grant')??'',process.env.CLAUS_TOOL_GATEWAY_SECRET??'');
  const config=await configuration();if(!config.settings.enabled||!operationsEnabled(config)||config.policy.capabilities.networkBuild!==true)throw Error();
  const db=sql(),owner=await ownedBrowserSession(grant.sessionId,grant.principal,db);
  if(owner.actionId!==grant.actionId||owner.workId!==grant.workId)throw Error();
  if(grant.workId){const [work]=await db`SELECT status FROM claus_network_work WHERE id=${grant.workId}`;if(!['ready','working','waiting'].includes(work?.status))throw Error();}
 }catch{return Response.json({error:'browser_download_denied'},{status:403,headers:{'cache-control':'no-store'}});}
 let upstream:Response;
 try{upstream=await fetch('https://api.browserbase.com/v1/downloads/'+grant.id,{headers:{...headers(),Accept:'application/octet-stream'},redirect:'error',signal:AbortSignal.any([req.signal,AbortSignal.timeout(270000)])});}
 catch{return Response.json({error:'browser_download_unavailable'},{status:502});}
 if(!upstream.ok||!upstream.body){await upstream.body?.cancel();return Response.json({error:'browser_download_unavailable'},{status:502});}
 if(upstream.headers.has('content-length')&&Number(upstream.headers.get('content-length'))!==grant.size){await upstream.body.cancel();return Response.json({error:'browser_download_size_changed'},{status:502});}
 const reader=upstream.body.getReader(),hash=createHash('sha256');let bytes=0;
 const stream=new ReadableStream<Uint8Array>({
  async pull(controller){try{const chunk=await reader.read();if(chunk.done){if(bytes!==grant.size||hash.digest('hex')!==grant.checksum)throw Error('browser_download_integrity_failed');controller.close();return;}bytes+=chunk.value.length;if(bytes>grant.size)throw Error('browser_download_size_changed');hash.update(chunk.value);controller.enqueue(chunk.value);}catch(e){await reader.cancel().catch(()=>{});controller.error(e);}},
  cancel:reason=>reader.cancel(reason)
 });
 return new Response(stream,{headers:{'content-type':'application/octet-stream','content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(grant.filename),'cache-control':'no-store','x-content-type-options':'nosniff','x-claus-sha256':grant.checksum,'x-claus-size':String(grant.size)}});
}
