import {createHash} from 'node:crypto';
import {sql} from './store.js';

export function referencedWork(records:any[]) {
 const ids=new Set<string>();
 for(const r of records)for(const match of String(r.body??'').matchAll(/\bnw_[a-z0-9_-]{1,80}\b/g))ids.add(match[0]);
 return [...ids].sort();
}

// Current task status is a separate dated projection, not a rewrite of the
// retained knowledge source or a new permission. Never expose it in Club.
export async function knowledgeWorkState(records:any[],channel='public',database:any=sql) {
 if(channel==='club')return {available:false,reason:'private_operating_state',items:[]};
 const ids=referencedWork(records);
 if(!ids.length)return {available:true,items:[],version:createHash('sha256').update('[]').digest('hex')};
 const rows=await database()`SELECT id,status,revision,summary,evidence,updated_at FROM claus_network_work
  WHERE id=ANY(${ids}::text[]) ORDER BY id`;
 const items=rows.map((r:any)=>({id:r.id,status:r.status,revision:r.revision,summary:r.summary,evidence:r.evidence,updatedAt:r.updated_at,
  terminal:['completed','cancelled'].includes(r.status),guidance:['completed','cancelled'].includes(r.status)?'This original task is closed. References instructing its original implementation are historical; reopen only for a concrete new regression or need.':'Read this original work item before acting on a historical plan.'}));
 return {available:true,items,unresolvedIds:ids.filter(id=>!rows.some((r:any)=>r.id===id)),version:createHash('sha256').update(JSON.stringify(items)).digest('hex'),
  observedAt:new Date().toISOString(),meaning:'Live recorded task status supersedes old task-to-do wording. It does not prove current service health or alter owner rules.'};
}
