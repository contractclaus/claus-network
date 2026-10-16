// Compact only redundant or separately retrievable observations. The canonical
// state, current messages, reply freshness stamps and owner policy stay intact.
export function operatingContext(view:any,fits:(value:any)=>boolean){
 if(fits(view))return view;
 const value=structuredClone(view),changed:string[]=[];
 const apply=(name:string,run:()=>void)=>{run();changed.push(name);value.contextWindow={compacted:changed,meaning:'A bounded view only. Canonical records and pending effects were not changed. Read referenced records before acting.'};return fits(value);};
 if(value.workProgress&&value.continuation?.progress&&apply('superseded continuation progress',()=>{value.continuation.progress={source:'workProgress'};}))return value;
 if(value.work?.networkWork&&value.networkWork&&apply('duplicate network work',()=>{value.work.networkWork={source:'networkWork',readMore:'Use network_work to read an exact work id.'};}))return value;
 if(value.social?.conversations&&apply('older author conversations',()=>{value.social.conversations=value.social.conversations.map((c:any)=>({authorId:c.authorId,nextBeforePostId:c.nextBeforePostId,readMore:'Use recall_conversation for this author. Current reply threads remain in threadContexts.'}));}))return value;
 if(value.continuation?.recentSteps&&value.continuation?.progress&&apply('duplicate continuation excerpts',()=>{value.continuation.recentSteps=[];}))return value;
 if(value.work?.surface&&apply('surface release detail',()=>{value.work.surface={readMore:'Use read_network_code for the current source revision, active release and original receipts. Not inspected in this compact view.'};}))return value;
 if(value.social?.relatedHistory&&apply('related historical posts',()=>{value.social.relatedHistory={readMore:'Use recall_conversation or read_x_account for historical public posts. Current messages and threadContexts are unchanged.'};}))return value;
 if(value.network?.inventory?.projects&&apply('project detail',()=>{value.network.inventory.projects=value.network.inventory.projects.map((p:any)=>({id:p.id,slug:p.slug,name:p.name,url:p.url,description:typeof p.description==='string'?p.description.slice(0,240):undefined,detailStatus:p.detailStatus,readMore:'Use read_network public_project with this slug for full current project facts.'}));}))return value;
 if(value.networkWork?.recent&&apply('completed work detail',()=>{value.networkWork.recent=value.networkWork.recent.map((w:any)=>({...w,summary:typeof w.summary==='string'?w.summary.slice(0,240):w.summary,readMore:'Use network_work with this id for the full record.'}));}))return value;
 if(value.work?.networkUpdates&&apply('release details',()=>{value.work.networkUpdates=value.work.networkUpdates.map((r:any)=>({id:r.id,status:r.status,urls:r.urls,verifiedAt:r.verifiedAt,readMore:'Inspect the existing release before announcing; retain this id and do not duplicate it.'}));}))return value;
 if(value.networkWork?.watch?.capabilities&&value.network?.capabilities&&apply('duplicate capabilities',()=>{value.networkWork.watch.capabilities={source:'network.capabilities',readMore:'Use network_work for the exact capability hash and full snapshot.'};}))return value;
 if(value.social?.recentPublicConversation&&apply('public conversation history',()=>{value.social.recentPublicConversation={readMore:'Use read_x_account or recall_conversation. Current incoming messages and reply contexts are retained.'};}))return value;
 if(value.social?.originalPost?.recent&&apply('older original text',()=>{value.social.originalPost.recent=value.social.originalPost.recent.map((r:any)=>({...r,text:typeof r.text==='string'?r.text.slice(0,360):r.text,textTruncated:typeof r.text==='string'&&r.text.length>360}));}))return value;
 // These are broad discovery snapshots, not execution permissions or current
 // reply context. Keep their status and exact discovery path while giving the
 // active task room to retain the source, schema and receipts it just read.
 if(value.network?.operations&&apply('network host details',()=>{value.network.operations={status:value.network.operationsStatus,readMore:'Use read_network network_operations for current host execution and heartbeat evidence.'};}))return value;
 if(value.network?.capabilities&&apply('network capability detail',()=>{value.network.capabilities={status:value.network.capabilitiesStatus,readMore:'Use read_network capabilities or describe the required build_network operation. Discovery is not permission; current policy and tool admission still apply.'};}))return value;
 if(value.network?.inventory&&apply('network inventory detail',()=>{
  const inventory=value.network.inventory;
  value.network.inventory={schemaVersion:inventory.schemaVersion,observedAt:inventory.observedAt,source:inventory.source,scope:inventory.scope,counts:inventory.counts,countScope:inventory.countScope,limits:inventory.limits,unknown:inventory.unknown,graphComplete:inventory.graphComplete,detailsComplete:inventory.detailsComplete,nextCursor:inventory.nextCursor,projects:(inventory.projects??[]).map((p:any)=>({id:p.id,slug:p.slug,url:p.url,detailStatus:p.detailStatus})),readMore:'Use read_network network_overview or public_project for the current project details. Retained counts have their original scope and cursor.'};
 }))return value;
 if(value.networkWork?.watch&&apply('network watch detail',()=>{value.networkWork.watch={pending:value.networkWork.watch.pending,failures:value.networkWork.watch.failures,readMore:'Use network_work to inspect current watch capabilities and opportunities; this projection supplies no execution grant.'};}))return value;
 if(value.networkWork?.recent&&apply('completed work summaries',()=>{value.networkWork.recent=value.networkWork.recent.map((w:any)=>({id:w.id,title:w.title,status:w.status,revision:w.revision,readMore:'Use network_work with this id for the original summary and evidence.'}));}))return value;
 if(value.work?.builder&&apply('builder detail',()=>{const builder=value.work.builder;value.work.builder={availability:builder.availability,projects:(builder.projects??[]).map((p:any)=>({id:p.id,status:p.status,revision:p.revision,title:p.title,nextCheckAt:p.nextCheckAt})),readMore:'Use read_prototype with the original id for source, pending outcomes and review evidence. Do not recreate work from this overview.'};}))return value;
 // Defer unrelated discovery details before evicting the active source/code.
 // Each record remains addressable; omitted arrays are explicitly unavailable,
 // never empty evidence or permission to ignore an outstanding effect.
 if(value.networkWork?.items&&apply('other work detail',()=>{
  const focused=value.networkWork.focus?.id;
  value.networkWork.items=value.networkWork.items.map((w:any)=>w.id===focused?w:{id:w.id,title:w.title,status:w.status,revision:w.revision,next_at:w.next_at,nextAt:w.nextAt,blocker:w.blocker,evidence:w.evidence,readMore:'Use network_work with this id for its complete goal, next step and summary before acting.'});
 }))return value;
 if(value.work?.networkUpdates&&apply('historical publication links',()=>{
  value.work.networkUpdates=value.work.networkUpdates.map((r:any)=>({id:r.id,status:r.status,verifiedAt:r.verifiedAt,readMore:'Read this original release before using its links or announcing it. This index is not a new publication.'}));
 }))return value;
 if(value.network?.inventory?.projects&&apply('deferred project index',()=>{
  const inventory=value.network.inventory;
  inventory.deferredProjectCount=inventory.projects.length;delete inventory.projects;
  inventory.projectDetailsDeferred=true;inventory.readMore='Project entries are omitted from this context view, not absent. Use read_network network_overview to obtain the actual entries and cursor. Counts retain their original scope.';
 }))return value;
 if(value.work?.ideas&&apply('deferred idea bodies',()=>{
  value.work.ideas=value.work.ideas.map((idea:any)=>({id:idea.id,title:idea.title,status:idea.status,readMore:'Use read_work with this original idea id before continuing its work.'}));
 }))return value;
 // Keep each admitted reply with its entire source context and freshness stamp.
 // Unselected inbox records are not marked delivered: cycle acknowledges only
 // value.social.messages after a model response. Nothing is deleted or replied
 // to from a fragment merely to fit the prompt.
 if(Array.isArray(value.social?.messages)&&Array.isArray(value.social?.threadContexts)){
  const allMessages=value.social.messages,allContexts=value.social.threadContexts;
  for(let count=allMessages.length-1;count>=1;count--){
   const selected=allMessages.slice(0,count),ids=new Set(selected.map((m:any)=>m.postId));
   const done=apply('bounded complete incoming conversations',()=>{value.social.messages=selected;value.social.threadContexts=allContexts.filter((c:any)=>ids.has(c.postId));value.social.deferredForContext={count:allMessages.length-count,meaning:'These inbox records remain pending and unacknowledged. Process them on subsequent turns. Do not infer that all received conversations are resolved.'};});
   if(done)return value;
  }
 }
 return value;
}
