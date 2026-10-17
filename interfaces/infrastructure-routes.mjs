export function infrastructureRoutes(route,string,integer,boolean,object){
  const project={projectId:string()},id={...project,resourceId:string(71)};
  const manifest=object({version:{const:1,type:'integer'},mode:{type:'string',enum:['http','worker','job','model']},image:string(256),region:string(40),cpu:{type:'integer',minimum:1,maximum:64},memoryMiB:{type:'integer',minimum:256,maximum:524288},gpu:{type:['string','null'],maxLength:100},port:{type:['integer','null'],minimum:1024,maximum:65535},healthPath:{type:['string','null'],maxLength:101},command:{type:'array',maxItems:32,items:{type:'string',maxLength:1000}},storageGiB:{type:'integer',minimum:0,maximum:2000},releaseHash:string(71)});
  return [
    route('resource_build_plan','POST','/v1/projects/{projectId}/infrastructure/build-plan',{...project,snapshotId:string(71),dockerfile:string(200)},['projectId','snapshotId']),
    route('resource_profiles','GET','/v1/projects/{projectId}/infrastructure/profiles',project),
    route('resource_instances','GET','/v1/projects/{projectId}/infrastructure',{...project,after:string(),limit:{type:'integer',minimum:1,maximum:100}},['projectId']),
    route('resource_quote','POST','/v1/projects/{projectId}/infrastructure/quotes',{...project,profileId:string(),manifest,leaseSeconds:{type:'integer',minimum:60,maximum:86400},idempotencyKey:string(128)}),
    route('resource_request','POST','/v1/projects/{projectId}/infrastructure',{...project,quoteId:string(71),idempotencyKey:string(128)}),
    route('resource_status','GET','/v1/projects/{projectId}/infrastructure/instances/{resourceId}',id),
    route('resource_logs','GET','/v1/projects/{projectId}/infrastructure/instances/{resourceId}/logs',id),
    route('resource_stop','POST','/v1/projects/{projectId}/infrastructure/instances/{resourceId}/stop',{...id,expectedRevision:integer}),
    route('resource_delete','DELETE','/v1/projects/{projectId}/infrastructure/instances/{resourceId}',{...id,expectedRevision:integer}),
    route('resource_update','POST','/v1/projects/{projectId}/infrastructure/instances/{resourceId}/replacement',{...id,expectedRevision:integer,quoteId:string(71),idempotencyKey:string(128)}),
    route('resource_profile_set','PUT','/v1/admin/infrastructure/profiles',{profile:object({id:string(),enabled:boolean,provider:{type:'string',enum:['fly','runpod']},accountId:string(),asset:string(),fundingAccount:string(),permissionHash:string(71),maxLeaseSeconds:{type:'integer',minimum:60,maximum:86400},maxPerLease:string(18),maxActive:{type:'integer',minimum:1,maximum:100},imagePrefixes:{type:'array',minItems:1,maxItems:100,items:string(200)},regions:{type:'array',minItems:1,maxItems:100,items:string(200)},maxCpu:{type:'integer',minimum:1,maximum:64},maxMemoryMiB:{type:'integer',minimum:256,maximum:524288},maxStorageGiB:{type:'integer',minimum:0,maximum:2000},gpuTypes:{type:'array',maxItems:100,items:string(200)}}),expectedRevision:integer}),
    route('resource_allowance_set','PUT','/v1/admin/infrastructure/allowances/{projectId}',{...project,profileId:string(),enabled:boolean,expiresAt:integer,limit:string(78),expectedRevision:integer})
  ];
}
