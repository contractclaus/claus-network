export function dataRoutes(route,string,integer){
 const project={projectId:string()},file={...project,fileId:string(71)};
 return [
  route('data_file_write','POST','/v1/projects/{projectId}/data-files/content',{...project,name:string(180),encoding:{type:'string',enum:['utf8','base64']},content:string(262144),idempotencyKey:string(128)},['projectId','name','content','idempotencyKey']),
  route('data_file_read','GET','/v1/projects/{projectId}/data-files/{fileId}/content',{...file,encoding:{type:'string',enum:['utf8','base64']}},['projectId','fileId']),
  route('data_file_prepare','POST','/v1/projects/{projectId}/data-files',{...project,name:string(180),sha256:string(71),bytes:{type:'integer',minimum:1,maximum:52428800},idempotencyKey:string(128)}),
  route('data_file_commit','POST','/v1/projects/{projectId}/data-files/{fileId}/commit',file),
  route('data_file_get','GET','/v1/projects/{projectId}/data-files/{fileId}',file),
  route('data_file_download','GET','/v1/projects/{projectId}/data-files/{fileId}/download',file),
  route('data_file_list','GET','/v1/projects/{projectId}/data-files',{...project,after:string(),limit:{type:'integer',minimum:1,maximum:100}},['projectId']),
  route('data_file_delete','DELETE','/v1/projects/{projectId}/data-files/{fileId}',{...file,expectedRevision:integer})
 ];
}
