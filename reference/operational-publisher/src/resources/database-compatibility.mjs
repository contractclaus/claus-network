import {digest,sameValue} from './store.mjs';
const fail=c=>{throw Error('resource_compatibility_'+c);};
const ref=v=>typeof v==='string'&&/^res_[a-f0-9]{24}$/.test(v);
export const compatibilityInputs={database_snapshot:['resourceId'],deployment_contract:['resourceId','deploymentId','databases','assessment'],deployment_contract_read:['resourceId','deploymentId']};
export function schemaDifferences(expected,current,mode){
 const changes=[];
 if(mode==='write'){if(expected.schemaHash!==current.schemaHash)changes.push('write_schema_changed');}
 else for(const table of expected.tables){const actual=current.tables.find(x=>x.name===table.name);if(!actual){changes.push('missing_table:'+table.name);continue;}if(actual.policiesHash!==table.policiesHash)changes.push('access_policy_changed:'+table.name);for(const column of table.columns){const c=actual.columns.find(x=>x.name===column.name);if(!c||c.dataType!==column.dataType||!column.nullable&&c.nullable)changes.push('incompatible_column:'+table.name+'.'+column.name);}}
 for(const m of expected.migrations)if(!current.migrations.includes(m))changes.push('missing_migration:'+m);
 return changes;
}
export function deploymentCompatibility({store,database,providers,open,now=Date.now}){
 const key=(id,d)=>id+':'+d;
 async function resource(id){if(!ref(id))fail('reference_invalid');const r=await store.get('resource',id);if(!r||r.protected||r.retirementPlanId||['removed','retired','retiring'].includes(r.status))fail('resource_inactive');return r;}
 async function connection(id){const r=await resource(id);if(r.provider!=='postgresql')fail('database_required');const s=await store.get('secret',r.connectionSecretId);if(s?.kind!=='database-connection'||s.status!=='active'||s.expiresAt&&Date.parse(s.expiresAt)<=now())fail('credential_inactive');return open(s.sealed,s.id+':'+s.version);}
 async function dependencies(id){const out=new Set();let offset=0;do{const p=await store.list('binding',offset);for(const b of p.items){if(b.resourceId!==id||b.status!=='bound')continue;const s=await store.get('secret',b.secretId);if(s?.kind==='database-connection')out.add(s.resourceId);}offset=p.nextOffset;}while(offset!==null);return [...out].sort();}
 async function contract(id,deploymentId){if(!ref(id)||!/^dpl_[A-Za-z0-9]+$/.test(deploymentId??''))fail('deployment_invalid');return store.get('deployment-contract',key(id,deploymentId));}
 async function locked(entries,callback,index=0,snapshots=[]){if(index===entries.length)return callback(snapshots);const e=entries[index];return database.withSchemaSnapshot(e.resourceId,await connection(e.resourceId),snapshot=>locked(entries,callback,index+1,[...snapshots,{...e,snapshot}]));}
 async function guard(r,deploymentId,callback){
  const deps=await dependencies(r.id),c=await contract(r.id,deploymentId);
  if(!deps.length&&!c)return callback();
  if(!c||deps.some(id=>!c.databases.some(x=>x.resourceId===id)))fail('deployment_contract_required');
  return locked(c.databases,async actual=>{
   for(const e of actual){const expected=c.databases.find(x=>x.resourceId===e.resourceId),differences=schemaDifferences(expected.snapshot,e.snapshot,e.mode);if(differences.length)fail('schema_changed_requires_migration_or_new_release');}
   return callback();
  });
 }
 return {guard,async call(operation,input,requestId){
  if(operation==='database_snapshot'){const r=await resource(input.resourceId);return database.withSchemaSnapshot(r.id,await connection(r.id),snapshot=>({resourceId:r.id,...snapshot,meaning:'Current schema and migration identities, never table data. Capture a deployment contract before incompatible changes.'}));}
  if(operation==='deployment_contract_read'){const c=await contract(input.resourceId,input.deploymentId);if(!c)fail('contract_missing');return c;}
  if(operation!=='deployment_contract'||typeof requestId!=='string'||!requestId||requestId.length>200||typeof input.assessment!=='string'||!input.assessment.trim()||input.assessment.length>2000||!Array.isArray(input.databases)||input.databases.length>16||input.databases.some(d=>!d||Object.keys(d).some(k=>!['resourceId','mode'].includes(k))||!ref(d.resourceId)||!['read','write'].includes(d.mode))||new Set(input.databases.map(d=>d.resourceId)).size!==input.databases.length)fail('input_invalid');
  const prior=await contract(input.resourceId,input.deploymentId);if(prior){if(!sameValue(prior.input,input))fail('immutable_contract_conflict');return prior;}
  const r=await resource(input.resourceId);if(r.provider!=='vercel')fail('project_required');
  const deployment=await providers.call('vercel','/v13/deployments/'+encodeURIComponent(input.deploymentId));if(deployment.projectId!==r.providerId||deployment.readyState!=='READY')fail('deployment_not_ready');
  const deps=await dependencies(r.id);if(deps.some(id=>!input.databases.some(x=>x.resourceId===id)))fail('database_binding_missing');
  return locked([...input.databases].sort((a,b)=>a.resourceId.localeCompare(b.resourceId)),async databases=>{
   const value={input,resourceId:r.id,deploymentId:input.deploymentId,databases,assessment:input.assessment,sourceRequestId:requestId,recordedAt:new Date(now()).toISOString(),contractHash:digest(databases),meaning:'Owner-declared code/schema compatibility. Promotion verifies schema under held database locks. Rollback keeps user data and requires compatible schema; this never restores or erases data.'};
   const saved=await store.put('deployment-contract',key(r.id,input.deploymentId),value);if(!sameValue(saved.value.input,input))fail('immutable_contract_conflict');return saved.value;
  });
 }};
}
