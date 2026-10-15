import {sql} from './store.js';

// Operator-only projection. Credentials, paths, balances and manifests never
// enter this observation or the work capability fingerprint.
export function projectOperationalCapabilities(rows:any[]|null){
 return {state:rows===null?'unavailable':'available',scopes:['api','native','web'].map(scope=>{
  const row=rows?.find(r=>r.scope===scope);
  if(!row||typeof row.enabled!=='boolean'||!Number.isSafeInteger(Number(row.revision)))return {scope,state:'unavailable',enabled:null};
  return {scope,state:'available',enabled:row.enabled,revision:Number(row.revision),profile:scope==='web'?'listed-website-source':'data-only-analysis/1'};
 }),scope:'Publishing grants only. These do not authorize SQL, host credentials, funds or arbitrary server code.'};
}
export async function readOperationalCapabilities(){
 try{return projectOperationalCapabilities(await sql()`SELECT scope,enabled,revision FROM claus_operations_control WHERE scope IN ('api','native','web')` as any[]);}
 catch{return projectOperationalCapabilities(null);}
}
