export function dataRecordRoutes(route,string,integer){
 const record={projectId:string(),namespace:{type:'string',pattern:'^[a-zA-Z0-9_.-]{1,120}$',minLength:1,maxLength:120},key:{type:'string',pattern:'^[a-zA-Z0-9_.-]{1,120}$',minLength:1,maxLength:120}};
 return [
  route('data_record_put','PUT','/v1/projects/{projectId}/data/{namespace}/{key}',{...record,value:true,expectedRevision:integer,idempotencyKey:string(128)}),
  route('data_record_get','GET','/v1/projects/{projectId}/data/{namespace}/{key}',record),
  route('data_record_list','GET','/v1/projects/{projectId}/data/{namespace}',{projectId:string(),namespace:record.namespace,after:string(512),limit:{type:'integer',minimum:1,maximum:100}},['projectId','namespace']),
  route('data_record_delete','DELETE','/v1/projects/{projectId}/data/{namespace}/{key}',{...record,expectedRevision:integer,idempotencyKey:string(128)})
 ];
}
