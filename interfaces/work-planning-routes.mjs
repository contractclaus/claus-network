export function workPlanningRoutes(route,string,integer,boolean,object,reviewPolicy){
 const context={projectId:string()},revision={expectedRevision:integer,idempotencyKey:string(128)};
 return [
 route('workflow_revise','PATCH','/v1/projects/{projectId}/workflows/{workflowId}',{...context,workflowId:string(),expectedRevision:integer,name:string(80),intervalSeconds:{type:'integer',minimum:60,maximum:2592000},maxRuns:{type:'integer',minimum:1,maximum:1000}}),
 route('webhook_create','POST','/v1/projects/{projectId}/webhooks',{...context,url:string(1500),idempotencyKey:string(128)}),
 route('webhook_list','GET','/v1/projects/{projectId}/webhooks',context),
 route('webhook_revoke','DELETE','/v1/projects/{projectId}/webhooks/{webhookId}',{...context,webhookId:string()}),
 route('project_assistance_set','PUT','/v1/projects/{projectId}/assistance',{...context,enabled:boolean,request:{type:'string',maxLength:1000},...revision}),
 route('public_project_assistance','GET','/v1/public/assistance',{after:string(),limit:{type:'integer',minimum:1,maximum:25}},[],true),
 route('project_actions_set','PUT','/v1/projects/{projectId}/actions',{...context,actions:{type:'array',maxItems:20,items:object({id:string(80),title:string(100),description:string(500),operation:string(80),input:true})},...revision}),
 route('public_project_actions','GET','/v1/public/projects/{projectId}/actions',context,undefined,true),
 route('job_brief_create','POST','/v1/projects/{projectId}/job-briefs',{...context,title:string(160),goal:string(2000),milestones:{type:'array',minItems:1,maxItems:8,items:object({title:string(160),criteria:{type:'array',minItems:1,maxItems:12,items:string(1000)},asset:{type:'string',enum:['ETH','CLAUS']},amountUnits:string(78),input:true,reviewPolicy},['title','criteria','asset','amountUnits','input'])},idempotencyKey:string(128)}),
 route('job_brief_get','GET','/v1/projects/{projectId}/job-briefs/{briefId}',{...context,briefId:string()}),
 route('job_milestone_post','POST','/v1/projects/{projectId}/job-briefs/{briefId}/milestones/{index}',{...context,briefId:string(),index:{type:'integer',minimum:0,maximum:7}}),
 route('reviewer_candidates','GET','/v1/projects/{projectId}/reviewer-candidates',{...context,skills:{type:'array',maxItems:20,items:string(40)},after:string(),limit:{type:'integer',minimum:1,maximum:25}},['projectId']),
 route('public_service_compare','GET','/v1/public/services/compare',{after:string(),limit:{type:'integer',minimum:1,maximum:100}},[],true),
 route('release_preview','GET','/v1/projects/{projectId}/releases/{releaseId}/preview',{...context,releaseId:string()}),
 route('release_restore','POST','/v1/projects/{projectId}/releases/{releaseId}/restore',{...context,releaseId:string(),expectedRevision:integer,idempotencyKey:string(128)})
 ];
}
