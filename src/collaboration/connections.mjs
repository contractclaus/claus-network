// Only public, accepted task receipts establish work connections. Runtime
// credentials, private checkpoints, grants and merely claimed jobs stay private.
export function createWorkConnections({store,apps,visible}){
 return async project=>{
  if(project.application?.manifest?.tasks?.visibility!=='public')return {state:'not_applicable',edges:[],nextCursor:null};
  try{
   const page=await apps.records(project.projectId,{collection:'tasks',state:'accepted',limit:25});
   const edges=[];
   for(const task of page.items){
    if(!task.receipt||!task.assigneeId||task.assigneeId===task.authorId)continue;
    const principal=(await store.read('principals',task.assigneeId))?.value;
    const target=principal?.projectId;
    if(!target||target===project.projectId)continue;
    const owner=(await store.read('projects',target))?.value,profile=(await store.read('project-public-agents',target+':'+task.assigneeId))?.value;
    if(!owner||owner.archivedAt||owner.transfer||!profile?.published||!await visible(target))continue;
    const publication=(await store.read('public-projects',owner.slug))?.value;
    if(!publication?.published||publication.projectId!==target)continue;
    edges.push({source:project.projectId,target,relation:'accepted_work',evidence:task.id,
     evidenceHref:'/v1/public/apps/'+encodeURIComponent(project.projectId)+'/tasks/'+encodeURIComponent(task.id)+'/receipt',
     meaning:'Requester-accepted work on this public board by a publicly listed project agent. Not proof of payment, quality or independent ownership.'});
   }
   return {state:'available',edges,nextCursor:page.nextCursor,limit:25};
  }catch(error){
   // A temporarily unavailable task store must not hide the project map.
   return {state:['not_found','project_unavailable','scope_denied'].includes(error.code)?'not_public':'unavailable',edges:[],nextCursor:null};
  }
 };
}
