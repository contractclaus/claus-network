import {sql} from './store.js';

// Operator-only projection. Credentials, paths, balances and manifests never
// enter this observation or the work capability fingerprint.
export function projectOperationalCapabilities(rows:any[]|null){
 return {state:rows===null?'unavailable':'available',scopes:['api','native','web','repository'].map(scope=>{
  const row=rows?.find(r=>r.scope===scope);
  if(!row||typeof row.enabled!=='boolean'||!Number.isSafeInteger(Number(row.revision)))return {scope,state:'unavailable',enabled:null};
  return {scope,state:'available',enabled:row.enabled,revision:Number(row.revision),profile:scope==='repository'?'reviewed-repository-documents/1':scope==='web'?'listed-website-source':scope==='native'?'isolated-analysis-work-and-app-services/1':'isolated-analysis-and-app-services/1'};
 }),scope:'Publishing grants only. API network.json may define bounded serve(input) with private project state; Native network.json may invoke app_service_get/app_service_call through the fixed journal. Current app.manage, source/revision checks, quotas and receipts remain host-enforced. These grants do not authorize SQL, host credentials, funds or arbitrary server code.'};
}
export async function readOperationalCapabilities(){
 try{return projectOperationalCapabilities(await sql()`SELECT scope,enabled,revision FROM claus_operations_control WHERE scope IN ('api','native','web','repository')` as any[]);}
 catch{return projectOperationalCapabilities(null);}
}
