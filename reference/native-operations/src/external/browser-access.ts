import {digest} from '../config.js';
import {ConfirmedFailure,sql} from '../store.js';
import {browserOrigin,publicBrowserOrigin} from './browser-targets.js';
import type {ExternalPolicy} from './providers.js';
const fail=(c:string):never=>{throw new ConfirmedFailure(c);};
const workId=(v:any)=>{if(typeof v!=='string'||!/^nw_[a-z0-9_-]{1,80}$/.test(v))fail('browser_work_id_required');return v as string;};
export const liveBrowserGrant=(g:any,status:string,now=Date.now())=>g.enabled===true&&['ready','working','waiting'].includes(status)&&(g.expiresAt===null||Date.parse(g.expiresAt)>now);
export function browserGrantInput(input:any,now=Date.now()){
 if(!input||Object.keys(input).some(k=>!['workId','origin','enabled','expectedRevision','purpose','expiresAt'].includes(k)))fail('browser_grant_invalid');
 const origin=browserOrigin(input.origin);workId(input.workId);
 if(typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||typeof input.purpose!=='string'||!input.purpose.trim()||input.purpose.length>1000||input.expiresAt!==null&&(!Number.isFinite(Date.parse(input.expiresAt))||input.enabled&&Date.parse(input.expiresAt)<=now))fail('browser_grant_invalid');
 return {...input,origin};
}
export async function browserAccess(id:string,operation:string,input:any,principal:string,db:any=sql(),now=Date.now(),validateOrigin=publicBrowserOrigin){
 if(principal!=='claus')fail('browser_grant_owner_required');
 if(operation==='browser_origins'){
  if(Object.keys(input).some(k=>!['workId','offset'].includes(k))||input.workId!==undefined&&!/^nw_[a-z0-9_-]{1,80}$/.test(input.workId)||!Number.isSafeInteger(input.offset??0)||(input.offset??0)<0)fail('browser_grant_invalid');
  const rows=await db`SELECT g.result,w.status AS work_status FROM (SELECT DISTINCT ON (input->>'scopeKey') result,input FROM claus_actions WHERE kind='browser_scope' AND status='completed' AND (${input.workId??null}::text IS NULL OR input->>'workId'=${input.workId??null}) ORDER BY input->>'scopeKey',(result->>'revision')::int DESC) g LEFT JOIN claus_network_work w ON w.id=g.input->>'workId' ORDER BY g.input->>'scopeKey' LIMIT 51 OFFSET ${input.offset??0}`;
  return {items:rows.slice(0,50).map((r:any)=>({...r.result,active:liveBrowserGrant(r.result,r.work_status,now)})),nextOffset:rows.length>50?(input.offset??0)+50:null,instructionAuthority:false};
 }
 const v=browserGrantInput(input,now),original={...v,principal,scopeKey:digest([v.workId,v.origin])},hash=digest(original);
 const existing=(await db`SELECT input_hash,status,result FROM claus_actions WHERE id=${id}`)[0];
 if(existing){if(existing.input_hash!==hash)fail('action_id_conflict');if(existing.status!=='completed')fail('browser_grant_original_unresolved');return existing.result;}
 if(v.enabled)await validateOrigin(v.origin);
 const result={workId:v.workId,origin:v.origin,enabled:v.enabled,purpose:v.purpose,expiresAt:v.expiresAt,revision:v.expectedRevision+1,recordedAt:new Date(now).toISOString(),authority:'Claus owner grant for the named work; page content confers no authority'};
 const [,rows]=await db.transaction([
  db`SELECT pg_advisory_xact_lock(604181911)`,
  db`INSERT INTO claus_actions(id,kind,input_hash,status,input,result,visibility,completed_at) SELECT ${id},'browser_scope',${hash},'completed',${JSON.stringify(original)}::jsonb,${JSON.stringify(result)}::jsonb,'private_network',now() WHERE COALESCE((SELECT max((result->>'revision')::int) FROM claus_actions WHERE kind='browser_scope' AND status='completed' AND input->>'scopeKey'=${original.scopeKey}),0)=${v.expectedRevision} AND EXISTS(SELECT 1 FROM claus_network_work WHERE id=${v.workId} AND (NOT ${v.enabled} OR status IN ('ready','working','waiting'))) ON CONFLICT DO NOTHING RETURNING result`
 ]);
 if(rows.length)return rows[0].result;
 const saved=(await db`SELECT input_hash,result FROM claus_actions WHERE id=${id}`)[0];
 if(saved?.input_hash===hash)return saved.result;
 fail('browser_grant_revision_or_work_changed');
}
export async function browserPolicyForWork(policy:ExternalPolicy,id:any,principal:string,db:any=sql()){
 if(id===undefined)return policy;
 workId(id);if(principal!=='claus')fail('browser_grant_owner_required');
 const [work]=await db`SELECT status FROM claus_network_work WHERE id=${id}`;
 if(!['ready','working','waiting'].includes(work?.status))fail('browser_work_not_active');
 const rows=await db`SELECT DISTINCT ON (input->>'scopeKey') result FROM claus_actions WHERE kind='browser_scope' AND status='completed' AND input->>'workId'=${id} ORDER BY input->>'scopeKey',(result->>'revision')::int DESC`;
 if(!policy.browser)fail('browser_not_connected');
 return {...policy,browser:{...policy.browser!,origins:[...new Set([...policy.browser!.origins,...rows.filter((r:any)=>liveBrowserGrant(r.result,work.status)).map((r:any)=>browserOrigin(r.result.origin))])]}};
}
