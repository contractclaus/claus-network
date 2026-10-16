import {digest} from '../config.js';
import {once,sql,ConfirmedFailure} from '../store.js';
import {externalPolicy,externalStatus,ProviderFailure,boundedObject,composioRequest,bazaarRequest,browserRequest,publicWeb,selectTool} from './providers.js';

export const externalOperations=['status','search','describe','call','connect','read','receipt','browser_open','browser_navigate','browser_read','browser_action','browser_close'] as const;
type Call={operation:string;provider?:string;input?:string;actionId?:string;offset?:number};
export function externalInput(raw:any):Call {
 const value=boundedObject(raw,32000);
 if(Object.keys(value).some(k=>!['operation','provider','input','actionId','offset'].includes(k))||!externalOperations.includes(value.operation)||value.provider!==undefined&&!['web','bazaar','composio','browserbase'].includes(value.provider)||value.input!==undefined&&typeof value.input!=='string'||value.actionId!==undefined&&(typeof value.actionId!=='string'||value.actionId.length>300)||value.offset!==undefined&&(!Number.isSafeInteger(value.offset)||value.offset<0))throw new ProviderFailure('external_request_invalid',true);
 return value as Call;
}
export function resultPage(actionId:string,value:unknown,offset=0){
 const text=JSON.stringify(value);if(offset>text.length)throw new ProviderFailure('external_offset_invalid',true);
 return text.length<=24000&&offset===0?{actionId,result:value,instructionAuthority:false}:{actionId,content:text.slice(offset,offset+24000),offset,totalChars:text.length,nextOffset:offset+24000<text.length?offset+24000:null,instructionAuthority:false};
}
function safeResult(value:any):any {
 if(Array.isArray(value))return value.map(safeResult);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/(?:^|_)(?:api_?key|access_?token|refresh_?token|secret|password|cookie|authorization|connect_?url)(?:$|_)/i.test(k)).map(([k,v])=>[k,safeResult(v)]));
 return value;
}
export async function externalTool(id:string,raw:any,principal='claus'){
 const call=externalInput(raw),policy=externalPolicy(),db=sql();
 if(call.operation==='status')return externalStatus(policy);
 if(call.operation==='receipt'){
  if(!call.actionId)throw new ConfirmedFailure('external_action_id_required');
  const row=(await db`SELECT id,status,result,input FROM claus_actions WHERE id=${call.actionId} AND kind='external_tools'`)[0];
  if(!row||principal!=='claus'&&row.input?.principal!==principal)throw new ConfirmedFailure('external_receipt_unavailable');
  return {status:row.status,...resultPage(row.id,row.result??{status:row.status,retry:false},call.offset)};
 }
 let input:any;try{input=boundedObject(JSON.parse(call.input??'{}'));}catch{throw new ConfirmedFailure('external_input_invalid');}
 const readOnly=call.provider==='web'||call.provider==='bazaar'||call.provider==='browserbase'&&call.operation==='browser_read'||call.provider==='composio'&&(['search','describe'].includes(call.operation)||call.operation==='call'&&selectTool(policy,input.tool,input.arguments??{}).rule.effect==='read');
 const original={...call,principal,readOnly};
 const admit=async()=>{
  const [,rows]=await db.transaction([db`SELECT pg_advisory_xact_lock(746201605)`,db`INSERT INTO claus_actions(id,kind,input_hash,status,input,visibility) SELECT ${id},'external_tools',${digest(original)},'pending',${JSON.stringify(original)}::jsonb,'private_network' WHERE ${readOnly} OR NOT EXISTS(SELECT 1 FROM claus_actions WHERE kind='external_tools' AND status NOT IN ('completed','failed') AND input->>'provider'=${call.provider??''} AND input->>'readOnly'='false') ON CONFLICT DO NOTHING RETURNING id`]);
  if(!rows.length&&!(await db`SELECT id FROM claus_actions WHERE id=${id}`).length)throw new ConfirmedFailure('external_provider_original_action_unresolved');return rows;
 };
 const value=await once(id,'external_tools',original,async()=>{
  try{
   let result:any;
   if(call.provider==='web'&&call.operation==='read')result=await publicWeb(input);
   else if(call.provider==='bazaar')result=await bazaarRequest(call.operation,input);
   else if(call.provider==='composio')result=await composioRequest(policy,call.operation,input);
   else if(call.provider==='browserbase'){
    if(call.operation!=='browser_open'){
     // A guessed provider session ID never grants access to another task's browser.
     const owner=(await db`SELECT id FROM claus_actions WHERE kind='external_tools' AND status='completed' AND input->>'principal'=${principal} AND input->>'operation'='browser_open' AND result->>'sessionId'=${input.sessionId??''} LIMIT 1`)[0];
     if(!owner)throw new ProviderFailure('browser_session_not_owned',true);
    }
    result=await browserRequest(policy,call.operation,input,id);
   }else throw new ProviderFailure('external_operation_invalid',true);
   const safe=safeResult(result);if(Buffer.byteLength(JSON.stringify(safe))>1000000)throw new ProviderFailure('external_response_too_large',false);
   return safe;
  }catch(e){if(e instanceof ProviderFailure&&e.confirmed)throw new ConfirmedFailure(e.message);throw e;}
 },db,admit);
 return resultPage(id,value,call.offset);
}
