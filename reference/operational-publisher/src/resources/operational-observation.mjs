// Private, read-only signals for the independent watcher. No task text,
// identifiers, URLs or credential values leave this boundary.
export async function operationalObservation({store,workStatus,native,enabled,now=Date.now}){
 const at=now(),active=s=>['ready','working','waiting'].includes(s),counts={expiredActiveGrants:0,expiredBoundSecrets:0,expiredQueueLeases:0,unknownQueueOutcomes:0,overdueQueueJobs:0,overdueAssignments:0,retirementsNeedingAttention:0};
 async function all(kind){const rows=[];let offset=0;do{const p=await store.list(kind,offset);rows.push(...p.items);offset=p.nextOffset;if(rows.length>50000)throw Error('resource_observation_inventory_incomplete');}while(offset!==null);return rows;}
 const [secrets,bindings,queues,assignments,retirements]=await Promise.all(['secret','binding','queue','assignment','retirement'].map(all));
 const work=new Map();async function workActive(id){if(!work.has(id))work.set(id,active(await workStatus(id)));return work.get(id);}
 for(const s of secrets){
  if(s.status!=='active'||!s.expiresAt||Date.parse(s.expiresAt)>at)continue;
  if(s.kind==='broker-grant'){if(await workActive(s.rules?.workId))counts.expiredActiveGrants++;}
  else for(const b of bindings.filter(b=>b.secretId===s.id&&b.status==='bound')){const r=await store.get('resource',b.resourceId);if(r&&!r.retirementPlanId&&r.status!=='removed'){counts.expiredBoundSecrets++;break;}}
 }
 for(const q of queues){
  if(!q.enabled||!await workActive(q.workId))continue;
  let offset=0,read=0;do{
   const page=await store.jobs(q.id,['queued','waiting','running','reconciling','blocked','accepted'],offset);
   for(const j of page.items){
    if(j.leaseUntil&&j.leaseUntil<at-300000)counts.expiredQueueLeases++;
    if(j.reason==='original_response_unknown')counts.unknownQueueOutcomes++;
    if(['queued','waiting'].includes(j.state)&&Date.parse(j.nextAt)<at-3600000)counts.overdueQueueJobs++;
   }
   read+=page.items.length;if(read>50000)throw Error('resource_observation_inventory_incomplete');offset=page.nextOffset;
  }while(offset!==null);
 }
 counts.overdueAssignments=assignments.filter(a=>!['accepted','failed','stopped'].includes(a.state)&&Date.parse(a.deadline)<at).length;
 counts.retirementsNeedingAttention=retirements.filter(r=>['blocked','waiting'].includes(r.state)&&Date.parse(r.updatedAt)<at-3600000).length;
 const runtime=await native();
 const needsAttention=Object.values(counts).some(n=>n>0)||runtime.expiredRuntimeLeases>0||runtime.overdueRunnableWork>0;
 return {version:1,observedAt:new Date(at).toISOString(),enabled,ok:!enabled||!needsAttention,needsAttention:enabled&&needsAttention,counts,runtime,readOnly:true,scope:'Recorded active work, owned credential expiries, original queue outcomes, runtime leases and deadlines. Unknown provider-side key expiry and unregistered accounts are not inferred.',thresholds:{expiredLeaseGraceSeconds:300,overdueWorkSeconds:3600},identifiersReturned:false};
}
