import {createHash} from 'node:crypto';
import {sql,configuration} from '../store.js';
import {operationsEnabled} from '../operations/service.js';
import {externalInput,externalTool} from './service.js';
import {readDevelopmentGrant,type Grant} from './development-grant.js';

export async function developmentToolsRoute(req:Request):Promise<Response>{
 let grant:Grant;
 try{grant=readDevelopmentGrant(req.headers.get('authorization')?.replace(/^Bearer /,'')??'',process.env.CLAUS_TOOL_GATEWAY_SECRET??'');}catch{return Response.json({error:'development_tool_grant_invalid'},{status:401});}
 if(Number(req.headers.get('content-length')??0)>35000)return Response.json({error:'request_too_large'},{status:413});
 // Bound the actual streamed body too; Content-Length may be absent or untrusted.
 const reader=req.body?.getReader();if(!reader)return Response.json({error:'request_required'},{status:400});
 let body='';try{const decoder=new TextDecoder();let bytes=0;for(;;){const p=await reader.read();if(p.done)break;bytes+=p.value.length;if(bytes>35000){await reader.cancel();return Response.json({error:'request_too_large'},{status:413});}body+=decoder.decode(p.value,{stream:true});}body+=decoder.decode();}catch{return Response.json({error:'request_unreadable'},{status:400});}
 let input:any;try{input=JSON.parse(body);if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(input.requestId))throw Error();externalInput(input.request);}catch{return Response.json({error:'request_invalid'},{status:400});}
 const config=await configuration();if(!config.settings.enabled||!operationsEnabled(config)||config.policy.capabilities.networkBuild!==true)return Response.json({error:'development_tools_disabled'},{status:403});
 const row=(await sql()`SELECT status,progress FROM claus_actions WHERE id=${grant.parent} AND kind='development'`)[0];
 if(!row||row.status!=='pending'||!['command_starting','command_running'].includes(row.progress?.execution?.phase)||Date.parse(row.progress?.execution?.deadline??'')!==grant.expires)return Response.json({error:'development_task_not_active'},{status:403});
 const id='external:guest:'+createHash('sha256').update(grant.parent+'\0'+input.requestId).digest('hex');
 const projectId=row.progress?.project?.id;
 if(!/^p_[a-f0-9]{32}$/.test(projectId??''))return Response.json({error:'development_project_not_available'},{status:403});
 try{return Response.json(await externalTool(id,input.request,grant.parent,'project:'+projectId),{headers:{'cache-control':'no-store'}});}catch(e){const message=e instanceof Error?e.message:'external_tool_unavailable';return Response.json({error:message.startsWith('action_')||/^[a-z_]+$/.test(message)?message:'external_tool_unavailable',actionId:id,retrySameRequestId:true},{status:409,headers:{'cache-control':'no-store'}});}
}
