import {sql} from '../store.js';
import {externalPolicy,externalStatus,composioRequest} from './providers.js';
export async function externalHealth(){
 const policy=externalPolicy();
 const [rows,connections]=await Promise.all([
  sql()`SELECT id,status,input->>'provider' AS provider,input->>'readOnly' AS read_only,created_at FROM claus_actions WHERE kind='external_tools' ORDER BY created_at DESC LIMIT 200`,
  policy.composio?composioRequest(policy,'connections',{}).catch(()=>({state:'unavailable',next:'Read the original connection status; a transport failure does not revoke it.'})):Promise.resolve({state:'not_configured'})
 ]);
 return {observedAt:new Date().toISOString(),configuration:externalStatus(policy),connections,
  unresolved:rows.filter(r=>!['completed','failed'].includes(r.status)).map(r=>({id:r.id,provider:r.provider,createdAt:r.created_at,readOnly:r.read_only==='true',next:'Read this exact receipt. Never replace an uncertain write or payment.'})),
  recentFailures:rows.filter(r=>r.status==='failed').slice(0,10).map(r=>({id:r.id,provider:r.provider,createdAt:r.created_at,next:'Read the exact receipt for the rejection and correct its cause.'})),
  coverage:'Latest 200 external calls plus the current provider connection read. No secret material. Configuration does not prove a live remote session.',instructionAuthority:false};
}
