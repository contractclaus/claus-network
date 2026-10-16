import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {chromium} from 'playwright-core';
import {readPublicUrl} from '../research.js';

export type ToolRule={toolkit:string;account?:string;effect:'read'|'write';fixed?:Record<string,unknown>};
export type ExternalPolicy={version:1;composio?:{sessionId:string;userId:string;tools:Record<string,ToolRule>;connectToolkits?:string[]};browser?:{projectId:string;origins:string[];contextId?:string;seconds:number;mode?:'single-request'|'persistent'}};
export class ProviderFailure extends Error {constructor(message:string,readonly confirmed:boolean,readonly retryAfter?:string){super(message);}}
const object=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function externalPolicy(env:NodeJS.ProcessEnv=process.env):ExternalPolicy {
 const raw=env.CLAUS_EXTERNAL_TOOL_POLICY;if(!raw)return {version:1};
 const p=JSON.parse(raw);if(p?.version!==1)throw Error('external_policy_invalid');
 if(p.composio&&(!/^trs_[A-Za-z0-9_-]+$/.test(p.composio.sessionId)||typeof p.composio.userId!=='string'||!object(p.composio.tools)))throw Error('external_policy_invalid');
 for(const [slug,r]of Object.entries(p.composio?.tools??{}) as [string,ToolRule][]){if(!/^[A-Z][A-Z0-9_]{1,159}$/.test(slug)||slug.startsWith('COMPOSIO_')||!r.toolkit||!['read','write'].includes(r.effect)||r.fixed!==undefined&&!object(r.fixed))throw Error('external_policy_invalid');}
 if(p.browser&&(!p.browser.projectId||(p.browser.mode!==undefined&&!['single-request','persistent'].includes(p.browser.mode))||!Array.isArray(p.browser.origins)||!p.browser.origins.length||p.browser.origins.some((x:any)=>typeof x!=='string'||new URL(x).origin!==x||!x.startsWith('https://'))||!Number.isInteger(p.browser.seconds)||p.browser.seconds<60||p.browser.seconds>600))throw Error('external_policy_invalid');
 return p;
}
export const externalStatus=(p=externalPolicy(),env:NodeJS.ProcessEnv=process.env)=>({
 profile:'claus-external-tools/2',adapters:{available:true,immutable:true,permissions:'current-provider-policy',scope:'claus-library-and-own-project'},development:{configured:!!env.CLAUS_TOOL_GATEWAY_SECRET&&!!env.CLAUS_TOOL_GATEWAY_ORIGIN},publicWeb:true,bazaar:{discovery:true,payments:false},
 composio:{configured:!!env.COMPOSIO_API_KEY&&!!p.composio,tools:Object.keys(p.composio?.tools??{}),missing:env.COMPOSIO_API_KEY&&p.composio?[]:['connected-provider-session']},
 browser:{configured:!!env.BROWSERBASE_API_KEY&&!!p.browser,origins:p.browser?.origins??[],mode:p.browser?.mode??'persistent',missing:env.BROWSERBASE_API_KEY&&p.browser?[]:['browser-provider-account']},
 secretsExposed:false,instructionAuthority:false
});
export function boundedObject(value:any,max=24000):Record<string,any>{if(!object(value)||Buffer.byteLength(JSON.stringify(value))>max)throw new ProviderFailure('external_input_invalid',true);return value;}
export function selectTool(p:ExternalPolicy,slug:string,args:any){
 const rules=p.composio?.tools;
 const rule=typeof slug==='string'&&/^[A-Z][A-Z0-9_]{1,159}$/.test(slug)&&rules&&Object.prototype.hasOwnProperty.call(rules,slug)?rules[slug]:undefined;
 if(!rule)throw new ProviderFailure('external_tool_not_authorized',true);
 const input=boundedObject(args);for(const[k,v]of Object.entries(rule.fixed??{}))if(k in input&&JSON.stringify(input[k])!==JSON.stringify(v))throw new ProviderFailure('external_tool_resource_mismatch',true);
 return {rule,arguments:{...input,...rule.fixed}};
}
export async function providerJson(url:string,init:RequestInit,readOnly:boolean,fetcher:typeof fetch=fetch){
 let r:Response;try{r=await fetcher(url,{...init,redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw new ProviderFailure('provider_transport_unavailable',readOnly);}
 if(!r.ok){await r.body?.cancel().catch(()=>{});const retry=r.headers.get('retry-after');throw new ProviderFailure('provider_http_'+r.status,readOnly||[400,401,403,404,405,422,429].includes(r.status),retry??undefined);}
 const reader=r.body?.getReader();if(!reader)throw new ProviderFailure('provider_empty_response',readOnly);
 const chunks:Uint8Array[]=[];let size=0;for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1000000){await reader.cancel();throw new ProviderFailure('provider_response_too_large',readOnly);}chunks.push(part.value);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ProviderFailure('provider_invalid_json',readOnly);}
}
const composioOrigin='https://backend.composio.dev/api/v3.1';
export async function composioRequest(p:ExternalPolicy,operation:string,input:any,fetcher:typeof fetch=fetch,env:NodeJS.ProcessEnv=process.env){
 if(!p.composio||!env.COMPOSIO_API_KEY)throw new ProviderFailure('composio_not_connected',true);
 const base=composioOrigin+'/tool_router/session/'+p.composio.sessionId;
 const headers={'x-api-key':env.COMPOSIO_API_KEY,'content-type':'application/json'};
 let path='',method='POST',body:any,readOnly=true;
 if(operation==='search'){if(typeof input.query!=='string'||!input.query.trim()||input.query.length>1000)throw new ProviderFailure('external_query_invalid',true);path='/search';body={queries:[{use_case:input.query}],search_strategy:'tool_search'};}
 else if(operation==='describe'){
  if(input.tool){if(!/^[A-Z][A-Z0-9_]{1,159}$/.test(input.tool))throw new ProviderFailure('external_tool_invalid',true);path='/execute';body={tool_slug:'COMPOSIO_GET_TOOL_SCHEMAS',arguments:{tool_slugs:[input.tool]},enable_auto_workbench_offload:false};}
  else{const params=new URLSearchParams({limit:'20'});if(input.cursor){if(typeof input.cursor!=='string'||input.cursor.length>2000)throw new ProviderFailure('external_cursor_invalid',true);params.set('cursor',input.cursor);}path='/tools?'+params;method='GET';}
 }else if(operation==='connect'){
  if(!(p.composio.connectToolkits??[]).includes(input.toolkit))throw new ProviderFailure('external_connection_not_authorized',true);
  path='/link';body={toolkit:input.toolkit};readOnly=false;
 }else if(operation==='call'){
  const selected=selectTool(p,input.tool,input.arguments??{});readOnly=selected.rule.effect==='read';path='/execute';
  body={tool_slug:input.tool,arguments:selected.arguments,...(selected.rule.account?{account:selected.rule.account}:{}),enable_auto_workbench_offload:false};
 }else throw new ProviderFailure('external_operation_invalid',true);
 const result=await providerJson(base+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})},readOnly,fetcher);
 if(result.error||result.data?.success===false||result.data?.successful===false||result.result_type&&result.result_type!=='completed')throw new ProviderFailure('composio_tool_failed',readOnly);
 return result;
}
export async function bazaarRequest(operation:string,input:any){
 if(!['search','describe'].includes(operation))throw new ProviderFailure('bazaar_discovery_only',true);
 const client=new Client({name:'claus-external-tools',version:'1.0.0'});
 const transport=new StreamableHTTPClientTransport(new URL('https://api.cdp.coinbase.com/platform/v2/x402/discovery/mcp'),{requestInit:{signal:AbortSignal.timeout(30000)}});
 try{
  await client.connect(transport);
  if(operation==='describe'){const r=await client.listTools();return {tools:r.tools.filter(t=>t.name==='search_resources'),paymentsEnabled:false};}
  if(typeof input.query!=='string'||input.query.length>1000)throw new ProviderFailure('external_query_invalid',true);
  const args:any={query:input.query,network:'eip155:8453',limit:10};
  if(input.maxUsdPrice!==undefined){if(typeof input.maxUsdPrice!=='string'||!/^\d{1,4}(\.\d{1,6})?$/.test(input.maxUsdPrice))throw new ProviderFailure('external_price_filter_invalid',true);args.maxUsdPrice=input.maxUsdPrice;}
  return await client.callTool({name:'search_resources',arguments:args},undefined,{timeout:30000});
 }catch(e){if(e instanceof ProviderFailure)throw e;throw new ProviderFailure('bazaar_discovery_unavailable',true);}finally{await client.close().catch(()=>{});}
}
export async function publicWeb(input:any){if(typeof input.url!=='string')throw new ProviderFailure('external_url_invalid',true);try{return await readPublicUrl(input.url,0,input.offset??0);}catch{throw new ProviderFailure('external_public_source_unavailable',true);}}

export function browserUrl(p:ExternalPolicy,raw:string){let u:URL;try{u=new URL(raw);}catch{throw new ProviderFailure('browser_url_invalid',true);}if(!p.browser||u.protocol!=='https:'||u.username||u.password||!p.browser.origins.includes(u.origin))throw new ProviderFailure('browser_origin_not_authorized',true);return u.href;}
export async function browserRequest(p:ExternalPolicy,operation:string,input:any,original:string){
 const spec=p.browser,key=process.env.BROWSERBASE_API_KEY;if(!spec||!key)throw new ProviderFailure('browser_not_connected',true);
 const headers={'X-BB-API-Key':key,'content-type':'application/json'};
 let opened:any;
 if(operation==='browser_open'){
  browserUrl(p,input.url);
  const r=await providerJson('https://api.browserbase.com/v1/sessions',{method:'POST',headers,body:JSON.stringify({projectId:spec.projectId,timeout:spec.seconds,keepAlive:spec.mode!=='single-request',userMetadata:{clausAction:original},browserSettings:{solveCaptchas:false,recordSession:false,logSession:false,ignoreCertificateErrors:false,allowedDomains:spec.origins.map(o=>new URL(o).hostname),...(spec.contextId?{context:{id:spec.contextId,persist:true}}:{})}})},false);
  if(typeof r.id!=='string')throw new ProviderFailure('browser_missing_session',false);
  // Navigation is a separate original action: a failed navigation cannot lose
  // the successfully created provider session or cause another session charge.
  if(spec.mode!=='single-request')return {sessionId:r.id,status:r.status,expiresAt:r.expiresAt,requestedUrl:input.url,next:'browser_navigate'};
  opened=r;input={...input,sessionId:r.id};operation='browser_navigate';
 }
 if(typeof input.sessionId!=='string'||!/^[a-zA-Z0-9-]{8,100}$/.test(input.sessionId))throw new ProviderFailure('browser_session_invalid',true);
 if(operation==='browser_close')return providerJson('https://api.browserbase.com/v1/sessions/'+input.sessionId,{method:'POST',headers,body:JSON.stringify({status:'REQUEST_RELEASE'})},false);
 if(spec.mode==='single-request'&&!opened)throw new ProviderFailure('browser_use_open_for_single_request',true);
 const session=opened??await providerJson('https://api.browserbase.com/v1/sessions/'+input.sessionId,{headers},true);
 if(session.projectId!==spec.projectId||typeof session.connectUrl!=='string')throw new ProviderFailure('browser_session_unavailable',true);
 const connect=new URL(session.connectUrl);if(connect.protocol!=='wss:'||!(connect.hostname==='connect.browserbase.com'||connect.hostname.endsWith('.browserbase.com')))throw new ProviderFailure('browser_connection_invalid',true);
 let browser:Awaited<ReturnType<typeof chromium.connectOverCDP>>|undefined;
 try{
  browser=await chromium.connectOverCDP(session.connectUrl,{timeout:20000});
  const context=browser.contexts()[0];if(!context)throw new ProviderFailure('browser_context_missing',true);
  await context.route('**/*',async route=>{const req=route.request();if(req.isNavigationRequest()&&req.frame()===req.frame().page().mainFrame()){try{browserUrl(p,req.url());}catch{await route.abort();return;}}await route.continue();});
  const page=context.pages()[0]??await context.newPage();page.setDefaultTimeout(10000);
  if(operation==='browser_navigate')await page.goto(browserUrl(p,input.url),{waitUntil:'domcontentloaded',timeout:20000});
  else if(operation==='browser_action'){
   browserUrl(p,page.url());
   const selector=boundedObject(input.target,2000);let loc;
   if(typeof selector.role==='string'&&typeof selector.name==='string')loc=page.getByRole(selector.role as any,{name:selector.name,exact:true});
   else if(typeof selector.label==='string')loc=page.getByLabel(selector.label,{exact:true});
   else throw new ProviderFailure('browser_target_invalid',true);
   if(await loc.count()!==1)throw new ProviderFailure('browser_target_not_unique',true);
   if(input.action==='click')await loc.click();else if(input.action==='fill'&&typeof input.value==='string'&&input.value.length<=8000)await loc.fill(input.value);else throw new ProviderFailure('browser_action_invalid',true);
  }else if(operation!=='browser_read')throw new ProviderFailure('external_operation_invalid',true);
  if(page.url()!=='about:blank')browserUrl(p,page.url());
  const text=(await page.locator('body').innerText()).slice(0,24000);
  const controls=await page.locator('a,button,input,textarea,select,[role="button"]').evaluateAll(nodes=>nodes.slice(0,80).map((n:any)=>({tag:n.tagName.toLowerCase(),role:n.getAttribute('role'),text:(n.innerText||n.getAttribute('aria-label')||n.getAttribute('placeholder')||'').slice(0,180),label:n.labels?.[0]?.innerText??null,type:n.type??null,href:n.tagName==='A'?n.getAttribute('href'):undefined})));
  return {sessionId:input.sessionId,...(opened?{sessionMode:'single-request',closedAfterRead:true}:{}),url:page.url(),title:await page.title(),text,controls,instructionAuthority:false};
 }catch(e){if(e instanceof ProviderFailure)throw e;throw new ProviderFailure('browser_action_outcome_unavailable',operation==='browser_read');}
 finally{
  let disconnected=false;
  if(browser)try{await browser.close();disconnected=true;}catch{}
  if(opened&&!disconnected)await providerJson('https://api.browserbase.com/v1/sessions/'+input.sessionId,{method:'POST',headers,body:JSON.stringify({status:'REQUEST_RELEASE'})},false);
 }
}
