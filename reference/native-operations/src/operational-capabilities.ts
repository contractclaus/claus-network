import {sql} from './store.js';

// Operator-only projection. Credentials, paths, balances and manifests never
// enter this observation or the work capability fingerprint.
export function projectOperationalCapabilities(rows:any[]|null){
 return {state:rows===null?'unavailable':'available',scopes:['api','native','web','repository'].map(scope=>{
  const row=rows?.find(r=>r.scope===scope);
  if(!row||typeof row.enabled!=='boolean'||!Number.isSafeInteger(Number(row.revision)))return {scope,state:'unavailable',enabled:null};
  return {scope,state:'available',enabled:row.enabled,revision:Number(row.revision),profile:scope==='repository'?'reviewed-repository-documents/1':'own-application-source/1'};
 }),scope:'Publishing grants for the configured own applications. Current scope controls determine editable source, dependencies, build configuration and website assets. Exact-source review, retained versions, deployment receipts and existing concurrency rules apply. Website hosting, DNS and structured database administration use manage_website. Separate provider credentials, signing and financial mandates remain enforced by their custodians.'};
}
export async function readOperationalCapabilities(){
 try{return projectOperationalCapabilities(await sql()`SELECT scope,enabled,revision FROM claus_operations_control WHERE scope IN ('api','native','web','repository')` as any[]);}
 catch{return projectOperationalCapabilities(null);}
}
