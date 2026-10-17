import {canonical,requireThat} from '../shared/index.mjs';
export const DATA_ACTIONS=Object.freeze(['data_file_write','data_file_read','data_file_get','data_file_list','data_record_put','data_record_get','data_record_list']);
export function dataScopes(access='none'){
 requireThat(['none','read','read_write'].includes(access),'runtime_data_access_invalid');
 return access==='none'?[]:access==='read'?['artifact.read']:['artifact.read','artifact.write'];
}
export function bindPrivateData(operation,input,projectId,access='none'){
 if(!DATA_ACTIONS.includes(operation))return;
 const scopes=dataScopes(access);requireThat(scopes.includes('artifact.read')&&(!['data_file_write','data_record_put'].includes(operation)||scopes.includes('artifact.write')),'runtime_private_data_denied');
 requireThat(input.projectId===undefined||input.projectId===projectId,'runtime_data_project_mismatch');input.projectId=projectId;
 if(['data_file_list','data_record_list'].includes(operation))input.limit=Math.min(input.limit??10,10);
 if(operation==='data_file_write')requireThat(typeof input.content==='string'&&Buffer.byteLength(input.content)<=8192,'runtime_data_too_large');
 if(operation==='data_record_put')requireThat(Buffer.byteLength(canonical(input.value))<=8192,'runtime_data_too_large');
}
export async function executeRuntimeAction(action,work,execute){
 bindPrivateData(action.operation,action.input,work.projectId,work.dataAccess??'none');
 if(action.operation==='data_file_read'){
  const file=await execute('data_file_get',{projectId:work.projectId,fileId:action.input.fileId},work.actor);
  requireThat(file&&Number.isSafeInteger(file.bytes)&&file.bytes<=4096,'runtime_data_too_large');
 }
 const result=await execute(action.operation,action.input,work.actor);
 if(['data_record_get','data_record_list'].includes(action.operation))requireThat(Buffer.byteLength(canonical(result))<=4096,'runtime_data_too_large');
 return result;
}
