export function infrastructureRoutes(route,string,integer,boolean,object){
  const project={projectId:string()},id={...project,resourceId:string(71)};
  const manifest=object({version:{const:1,type:'integer'},mode:{type:'string',enum:['http','worker','job','model']},image:string(256),region:string(40),cpu:{type:'integer',minimum:1,maximum:64},memoryMiB:{type:'integer',minimum:256,maximum:524288},gpu:{type:['string','null'],maxLength:100},port:{type:['integer','null'],minimum:1024,maximum:65535},healthPath:{type:['string','null'],maxLength:101},command:{type:'array',maxItems:32,items:{type:'string',maxLength:1000}},storageGiB:{type:'integer',minimum:0,maximum:4096},releaseHash:string(71)});
  manifest.properties.gpuCount={type:'integer',minimum:0,maximum:8};
  manifest.properties.minimumVramGiB={type:'integer',minimum:0,maximum:1024};
  manifest.properties.networkVolume=object({resourceId:string(28),path:string(200)});
  manifest.properties.secretBindings={type:'array',maxItems:32,items:object({envName:string(101),secretId:string(28),version:{type:'integer',minimum:1}})};
  manifest.properties.egressBudgetMiB={type:'integer',minimum:1,maximum:1000000};
  const {releaseHash,...runtimeProperties}=manifest.properties;
  const runtimeManifest=object(runtimeProperties),release={...project,releaseId:string(71)};
  runtimeManifest.required=manifest.required.filter(k=>k!=='releaseHash');
  const profile=object({id:string(),enabled:boolean,provider:{type:'string',enum:['fly','runpod']},accountId:string(),asset:string(),fundingAccount:string(),permissionHash:string(71),maxLeaseSeconds:{type:'integer',minimum:60,maximum:86400},maxPerLease:string(18),maxActive:{type:'integer',minimum:1,maximum:100},imagePrefixes:{type:'array',minItems:1,maxItems:100,items:string(200)},regions:{type:'array',minItems:1,maxItems:100,items:string(200)},maxCpu:{type:'integer',minimum:1,maximum:64},maxMemoryMiB:{type:'integer',minimum:256,maximum:524288},maxStorageGiB:{type:'integer',minimum:0,maximum:4096},gpuTypes:{type:'array',maxItems:100,items:string(200)}});
  profile.properties.maxGpuCount={type:'integer',minimum:0,maximum:8};
  profile.properties.billingMode={type:'string',enum:['postpaid']};
  const scalingSource=object({kind:{type:'string',enum:['reported','owned-queue']}});
  scalingSource.properties.queueId=string(28);scalingSource.properties.workId=string(84);
  return [
    route('resource_scaling_list','GET','/v1/projects/{projectId}/infrastructure/scaling',{...project,after:string(),limit:{type:'integer',minimum:1,maximum:100}},['projectId']),
    route('resource_scaling_get','GET','/v1/projects/{projectId}/infrastructure/scaling/{name}',{...project,name:string(81)}),
    route('resource_scaling_set','PUT','/v1/projects/{projectId}/infrastructure/scaling/{name}',{...project,name:string(81),expectedRevision:integer,enabled:boolean,profileId:string(),manifest,source:scalingSource,minReplicas:{type:'integer',minimum:0,maximum:100},maxReplicas:{type:'integer',minimum:1,maximum:100},targetBacklog:{type:'integer',minimum:1,maximum:1000000},scaleUpCooldownSeconds:{type:'integer',minimum:30,maximum:3600},scaleDownDelaySeconds:{type:'integer',minimum:60,maximum:86400},leaseSeconds:{type:'integer',minimum:300,maximum:86400},stateMode:{type:'string',const:'external-durable'}}),
    route('resource_scaling_signal','POST','/v1/projects/{projectId}/infrastructure/scaling/{name}/signal',{...project,name:string(81),sampleId:string(128),observedAt:integer,backlog:{type:'integer',minimum:0,maximum:1000000},busy:{type:'integer',minimum:0,maximum:1000000}}),
    route('resource_fleet','GET','/v1/infrastructure',{after:string(),limit:{type:'integer',minimum:1,maximum:10}},[]),
    route('resource_control_set','PUT','/v1/admin/infrastructure/controls',{profile,operators:{type:'array',items:string(),minItems:1,maxItems:16},enabled:boolean,expiresAt:{type:['integer','null']},totalLimit:string(78),perProjectLimit:string(78),dailyLimit:string(78),expectedRevision:integer}),
    route('resource_control','GET','/v1/infrastructure/controls/{profileId}',{profileId:string()}),
    route('resource_grants','GET','/v1/infrastructure/controls/{profileId}/grants',{profileId:string(),after:string(),limit:{type:'integer',minimum:1,maximum:100}},['profileId']),
    route('resource_grant_set','PUT','/v1/infrastructure/controls/{profileId}/grants/{projectId}',{...project,profileId:string(),enabled:boolean,expiresAt:{type:['integer','null']},limit:string(78),expectedRevision:integer,idempotencyKey:string(128),reason:string(1000)}),
    route('resource_release_private_prepare','POST','/v1/projects/{projectId}/infrastructure/private-releases',{...project,resourceId:string(28),actionId:string(28),manifest:runtimeManifest}),
    route('resource_release_prepare','POST','/v1/projects/{projectId}/infrastructure/releases',{...project,buildId:string(71),manifest:runtimeManifest}),
    route('resource_release_get','GET','/v1/projects/{projectId}/infrastructure/releases/{releaseId}',release),
    route('resource_release_owner_review','POST','/v1/projects/{projectId}/infrastructure/releases/{releaseId}/owner-review',{...release,report:string(32000),findingsJson:string(16000),published:{type:'boolean'}}),
    route('resource_release_owner_inspect','GET','/v1/projects/{projectId}/infrastructure/releases/{releaseId}/owner-review',{...release,reviewId:string(71)}),
    route('resource_release_owner_approve','POST','/v1/projects/{projectId}/infrastructure/releases/{releaseId}/owner-approval',{...release,reviewId:string(71),reportHash:string(71),reason:string(4000),acknowledgedFindings:{type:'array',maxItems:50,items:string(71)},expectedRevision:integer}),
    route('public_resource_owner_review','GET','/v1/public/infrastructure/owner-reviews/{reviewId}',{reviewId:string(71)},['reviewId'],true),
    route('resource_release_inspect','GET','/v1/projects/{projectId}/infrastructure/releases/{releaseId}/review',{...release,caseId:string(71)}),
    route('resource_release_approve','POST','/v1/projects/{projectId}/infrastructure/releases/{releaseId}/approval',{...release,caseId:string(71),reportHash:string(71),reason:string(4000),acknowledgedFindings:{type:'array',maxItems:200,items:string(71)},expectedRevision:integer}),
    route('resource_release_revoke','DELETE','/v1/projects/{projectId}/infrastructure/releases/{releaseId}/approval',{...release,expectedRevision:integer}),
    route('public_resource_release','GET','/v1/public/infrastructure/releases/{releaseId}',{releaseId:string(71)},['releaseId'],true),
    route('resource_image_publish','PUT','/v1/projects/{projectId}/infrastructure/builds/{buildId}/image',{...project,buildId:string(71),publishImage:boolean,expectedRevision:integer}),
    route('resource_build','POST','/v1/projects/{projectId}/infrastructure/builds',{...project,snapshotId:string(71),dockerfile:string(200),publishSource:{type:'boolean'},sourceVisibility:{type:'string',enum:['public','private']},idempotencyKey:string(128)},['projectId','snapshotId','idempotencyKey']),
    route('resource_build_publish','POST','/v1/projects/{projectId}/infrastructure/builds/{buildId}/publication',{...project,buildId:string(71),publishSource:{type:'boolean',const:true},expectedRevision:integer}),
    route('resource_build_status','GET','/v1/projects/{projectId}/infrastructure/builds/{buildId}',{...project,buildId:string(71)}),
    route('resource_build_artifact','GET','/v1/projects/{projectId}/infrastructure/builds/{buildId}/artifact',{...project,buildId:string(71)}),
    route('resource_build_source','GET','/v1/public/infrastructure/builds/{buildId}/source',{buildId:string(71)},['buildId'],true),
    route('resource_build_plan','POST','/v1/projects/{projectId}/infrastructure/build-plan',{...project,snapshotId:string(71),dockerfile:string(200)},['projectId','snapshotId']),
    route('resource_readiness','GET','/v1/projects/{projectId}/infrastructure/readiness',project),
    route('resource_renew','POST','/v1/projects/{projectId}/infrastructure/instances/{resourceId}/renew',{...id,expectedRevision:integer,quoteId:string(71),idempotencyKey:string(128)}),
    route('resource_maintenance_set','PUT','/v1/projects/{projectId}/infrastructure/instances/{resourceId}/maintenance',{...id,expectedRevision:integer,policy:{type:['object','null'],properties:{until:{type:['integer','null']},leaseSeconds:{type:'integer',minimum:60,maximum:86400},renewBeforeSeconds:{type:'integer',minimum:60,maximum:1800},maxTotalCost:{type:['string','null'],maxLength:78}},required:['until','leaseSeconds','renewBeforeSeconds','maxTotalCost'],additionalProperties:false}}),
    route('resource_profiles','GET','/v1/projects/{projectId}/infrastructure/profiles',project),
    route('resource_instances','GET','/v1/projects/{projectId}/infrastructure',{...project,after:string(),limit:{type:'integer',minimum:1,maximum:100}},['projectId']),
    route('resource_quote','POST','/v1/projects/{projectId}/infrastructure/quotes',{...project,profileId:string(),manifest,leaseSeconds:{type:'integer',minimum:60,maximum:86400},idempotencyKey:string(128)}),
    route('resource_request','POST','/v1/projects/{projectId}/infrastructure',{...project,quoteId:string(71),idempotencyKey:string(128)}),
    route('resource_status','GET','/v1/projects/{projectId}/infrastructure/instances/{resourceId}',id),
    route('resource_logs','GET','/v1/projects/{projectId}/infrastructure/instances/{resourceId}/logs',id),
    route('resource_stop','POST','/v1/projects/{projectId}/infrastructure/instances/{resourceId}/stop',{...id,expectedRevision:integer}),
    route('resource_delete','DELETE','/v1/projects/{projectId}/infrastructure/instances/{resourceId}',{...id,expectedRevision:integer}),
    route('resource_update','POST','/v1/projects/{projectId}/infrastructure/instances/{resourceId}/replacement',{...id,expectedRevision:integer,quoteId:string(71),idempotencyKey:string(128)}),
    route('resource_profile_set','PUT','/v1/admin/infrastructure/profiles',{profile,expectedRevision:integer}),
    route('resource_allowance_set','PUT','/v1/admin/infrastructure/allowances/{projectId}',{...project,profileId:string(),enabled:boolean,expiresAt:integer,limit:string(78),expectedRevision:integer})
  ];
}
