import {externalAccessState} from './access-state.js';
import {sql} from '../store.js';
import {externalPolicy,externalStatus,composioRequest} from './providers.js';
export async function externalHealth({database=sql,readConnections=composioRequest}:any={}){
 const policy=externalPolicy();
 const [rows,pending,connections]=await Promise.all([
  database()`SELECT id,status,input->>'provider' AS provider,input->>'readOnly' AS read_only,created_at FROM claus_actions WHERE kind='external_tools' ORDER BY created_at DESC LIMIT 200`,
  database()`SELECT id,status,input->>'provider' AS provider,input->>'readOnly' AS read_only,created_at,count(*) OVER()::int AS total FROM claus_actions WHERE kind='external_tools' AND status NOT IN ('completed','failed') ORDER BY created_at ASC,id ASC LIMIT 200`,
  policy.composio?readConnections(policy,'connections',{}).catch(()=>({state:'unavailable',next:'Read the original connection status; a transport failure does not revoke it.'})):Promise.resolve({state:'not_configured'})
 ]);
 return {observedAt:new Date().toISOString(),configuration:externalStatus(policy),connections,access:externalAccessState(externalStatus(policy),connections),
  unresolved:pending.map((r:any)=>({id:r.id,provider:r.provider,createdAt:r.created_at,readOnly:r.read_only==='true',next:'Read this exact receipt. Never replace an uncertain write or payment.'})),
  unresolvedCoverage:{total:pending.length?Number(pending[0].total):0,returned:pending.length,complete:pending.length===0||Number(pending[0].total)<=pending.length},
  recentFailures:rows.filter((r:any)=>r.status==='failed').slice(0,10).map((r:any)=>({id:r.id,provider:r.provider,createdAt:r.created_at,next:'Read the exact receipt for the rejection and correct its cause.'})),
  coverage:'Latest 200 external calls and oldest 200 unresolved calls independently, plus the current provider connection read. No secret material. Configuration does not prove a live remote session.',instructionAuthority:false};
}
