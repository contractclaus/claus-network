import {resourceDatabase} from './database.mjs';
import {timingSafeEqual} from 'node:crypto';
import {resourceStore,digest} from './store.mjs';
import {resourceProviders,team,validateSettings} from './providers.mjs';
import {sealSecret,openSecret,secretMetadata,newSecretValue} from './vault.mjs';
const fail=message=>{throw Error('resource_'+message);};
const ref=(value,prefix)=>{if(typeof value!=='string'||!new RegExp('^'+prefix+'_[a-f0-9]{24}$').test(value))fail('reference_invalid');return value;};
const safeName=value=>{if(typeof value!=='string'||! /^[a-z][a-z0-9-]{1,40}$/.test(value))fail('name_invalid');return value;};
const envName=value=>{if(typeof value!=='string'||! /^[A-Z][A-Z0-9_]{1,100}$/.test(value)||/^(?:NEXT_PUBLIC_|PUBLIC_|VITE_|VERCEL_|NODE_)/.test(value))fail('secret_environment_invalid');return value;};
const same=(a,b)=>digest(a)===digest(b);
const website={id:'website',provider:'vercel',providerId:'prj_3EPhg3tuhf5oHU9sw2Butj9eRegy',name:'claus',owner:team,kind:'existing-website',protected:true};
const grantOperations=['resource','deployments','bindings','settings','bind_secret'];
const inputKeys={database_create:['name','purpose'],database_schema:['resourceId'],database_migrate:['resourceId','plan'],status:[],identity:['provider'],resources:['offset'],resource:['resourceId'],secrets:['offset'],bindings:['resourceId'],deployments:['resourceId'],logs:['resourceId','deploymentId'],action:['id'],project_create:['name','purpose'],repository_create:['name','purpose','private'],secret_create:['name','expiresAt'],grant_create:['name','expiresAt','resourceIds','secretIds','operations','workId'],secret_rotate:['secretId','expectedRevision'],secret_revoke:['secretId','expectedRevision'],bind_secret:['resourceId','secretId','version','envName'],settings:['resourceId','settings']};
export function createResourceService({database=resourceDatabase(),store=resourceStore(),providers=resourceProviders(),seal=sealSecret,open=openSecret,now=Date.now,environment=process.env,workStatus=async()=>null}={}){
 async function resource(id){if(id==='website')return website;ref(id,'res');const v=await store.get('resource',id);if(!v)fail('not_found');return v;}
 async function secret(id){ref(id,'sec');const v=await store.get('secret',id);if(!v)fail('secret_not_found');return v;}
 async function databaseConnection(r){const s=await secret(r.connectionSecretId);active(s);return open(s.sealed,s.id+':'+s.version);}
 async function all(kind){const out=[];let offset=0;for(;;){const p=await store.list(kind,offset);out.push(...p.items);if(p.nextOffset===null)return out;offset=p.nextOffset;}}
 const active=s=>{if(s.status!=='active'||s.expiresAt&&Date.parse(s.expiresAt)<=now())fail('secret_inactive');};
 const stamp=()=>new Date(now()).toISOString();
 const metadata=r=>({id:r.id,provider:r.provider,providerId:r.providerId,name:r.name,owner:r.owner,url:r.url??null,private:r.private??null,kind:r.kind,revision:r.revision??1,createdAt:r.createdAt??null,...(r.provider==='postgresql'?{database:r.database,schema:r.schema,connectionSecretId:r.connectionSecretId}: {})});
 async function authorization(token,operation,input){
  const m=/^claus_(sec_[a-f0-9]{24})\.[a-zA-Z0-9_-]{43}$/.exec(token??'');if(!m)fail('grant_invalid');
  const s=await secret(m[1]);active(s);if(s.kind!=='broker-grant'||!s.rules?.operations.includes(operation)||!s.rules.resourceIds.includes(input.resourceId))fail('grant_scope_denied');
  if(input.secretId&&!s.rules.secretIds.includes(input.secretId))fail('grant_scope_denied');
  if(!['ready','working','waiting'].includes(await workStatus(s.rules.workId)))fail('grant_work_inactive');
  const bytes=Buffer.from(open(s.sealed,s.id+':'+s.version)),given=Buffer.from(token);if(bytes.length!==given.length||!timingSafeEqual(bytes,given))fail('grant_invalid');return s.id;
 }
 async function redactedLogs(r,deploymentId){
  if(r.protected)fail('use_existing_protected_diagnostics');
  const logs=await providers.logs(r,deploymentId),values=Object.entries(environment).filter(([k,v])=>typeof v==='string'&&v.length>=8&&/(TOKEN|SECRET|PASSWORD|KEY|DATABASE_URL)/.test(k)).map(([,v])=>v);
  const bound=[...await all('binding'),...await all('binding-history')].filter(b=>b.resourceId===r.id);
  for(const b of bound){const v=await store.get('secret-version',b.secretId+':'+b.version);if(!v)fail('log_redaction_unavailable');values.push(open(v.sealed,v.id+':'+v.version));}
  for(const value of [...values])try{const u=new URL(value);if(u.password.length>=8)values.push(u.password,decodeURIComponent(u.password));}catch{}
  const clean=s=>{for(const v of values)if(v.length>=8)s=s.split(v).join('[redacted]');return s.replace(/Bearer\s+[A-Za-z0-9_.~+\/-]+/gi,'Bearer [redacted]').replace(/([?&](?:token|key|secret|signature|password)=)[^&\s]+/gi,'$1[redacted]');};
  return {...logs,events:logs.events.map(e=>({...e,text:clean(e.text)}))};
 }
 async function call(operation,input,requestId,{grant=null}={}){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('input_invalid');
  if(!inputKeys[operation]||Object.keys(input).some(k=>!inputKeys[operation].includes(k)))fail('input_invalid');
  const principal=grant?await authorization(grant,operation,input):'owner';
  const offset=input.offset??0;if(!Number.isSafeInteger(offset)||offset<0)fail('offset_invalid');
  if(operation==='status')return {version:1,configured:providers.configured(),scope:'Claus-owned projects, application secret references and revocable broker grants',website:metadata(website),operations:['resources','resource','identity','project_create','repository_create','database_create','database_schema','database_migrate','settings','deployments','logs','secrets','secret_create','secret_rotate','secret_revoke','grant_create','bind_secret','bindings','action'],providerBilling:'Project/repository creation does not reserve a running server. Compute leases retain their existing shared operating budget.',secretValuesReturned:false};
  if(operation==='identity'){if(!['vercel','github'].includes(input.provider))fail('provider_invalid');return providers.identity(input.provider);}
  if(operation==='resources'){const p=await store.list('resource',offset);return {...p,items:p.items.map(metadata)};}
  if(operation==='database_schema'){const r=await resource(input.resourceId);if(r.provider!=='postgresql')fail('provider_invalid');const key=await secret(r.connectionSecretId);active(key);return database.inspect(r.id,open(key.sealed,key.id+':'+key.version));}
  if(operation==='resource'){const r=await resource(input.resourceId);return {...metadata(r),observation:r.provider==='postgresql'?await database.inspect(r.id,await databaseConnection(r)):await providers.read(r),observedAt:stamp()};}
  if(operation==='secrets'){const p=await store.list('secret',offset);return {...p,items:p.items.map(secretMetadata)};}
  if(operation==='bindings')return {items:(await all('binding')).filter(b=>!input.resourceId||b.resourceId===input.resourceId).map(b=>({resourceId:b.resourceId,secretId:b.secretId,version:b.version,envName:b.envName,status:b.status,updatedAt:b.updatedAt,requiresDeployment:true}))};
  if(operation==='deployments'){const r=await resource(input.resourceId);if(r.provider!=='vercel')fail('provider_invalid');return {items:await providers.deployments(r)};}
  if(operation==='logs'){const r=await resource(input.resourceId);if(r.provider!=='vercel'||!/^dpl_[A-Za-z0-9]+$/.test(input.deploymentId??''))fail('deployment_invalid');return redactedLogs(r,input.deploymentId);}
  if(operation==='action'){ref(input.id,'act');const r=await store.get('action',input.id);if(!r)fail('action_not_found');return {id:input.id,operation:r.operation,phase:r.output?'completed':r.phase,output:r.output??null,next:r.output?null:'Repeat the original request ID and exact input to reconcile it.'};}
  if(typeof requestId!=='string'||!requestId||requestId.length>200)fail('request_id_invalid');
  const actionId='act_'+digest([principal,requestId]).slice(0,24),existing=await store.get('action',actionId);
  if(existing&&(!same(existing.input,input)||existing.operation!==operation))fail('request_conflict');
  if(existing?.output)return existing.output;
  let prepared=existing?.prepared;
  if(!prepared){
   if(operation==='project_create'||operation==='repository_create'){
    safeName(input.name);if(typeof input.purpose!=='string'||!input.purpose.trim()||input.purpose.length>350)fail('purpose_required');if(input.private!==undefined&&typeof input.private!=='boolean')fail('privacy_invalid');
    prepared={provider:operation==='project_create'?'vercel':'github',name:'claus-'+input.name+'-'+actionId.slice(-8)};
   }else if(operation==='database_create'){
    safeName(input.name);if(typeof input.purpose!=='string'||!input.purpose.trim()||input.purpose.length>350)fail('purpose_required');
    const id='res_'+digest(actionId).slice(0,24),secretId='sec_'+digest(actionId+':database').slice(0,24),connection=database.connection(id,newSecretValue());
    prepared={id,name:input.name,purpose:input.purpose,secret:{id:secretId,name:input.name+'-database',kind:'database-connection',resourceId:id,version:1,revision:1,status:'active',createdAt:stamp(),updatedAt:stamp(),expiresAt:null,sealed:seal(connection,secretId+':1'),lastAction:actionId}};
   }else if(operation==='database_migrate'){
    const r=await resource(input.resourceId);if(r.provider!=='postgresql')fail('provider_invalid');prepared={resource:r,sourceHash:digest(input.plan)};
   }else if(operation==='secret_create'||operation==='grant_create'){

    safeName(input.name);if(input.expiresAt!==undefined&&(!Number.isFinite(Date.parse(input.expiresAt))||Date.parse(input.expiresAt)<=now()))fail('expiry_invalid');
    const id='sec_'+digest(actionId).slice(0,24),kind=operation==='grant_create'?'broker-grant':'application';
    let rules=null;
    if(kind==='broker-grant'){
     if(!Array.isArray(input.resourceIds)||!input.resourceIds.length||input.resourceIds.length>100||!Array.isArray(input.operations)||!input.operations.length||input.operations.some(v=>!grantOperations.includes(v))||!/^nw_[a-z0-9_-]{1,80}$/.test(input.workId??'')||!input.expiresAt)fail('grant_rules_invalid');
     if(!['ready','working','waiting'].includes(await workStatus(input.workId)))fail('grant_work_inactive');
     for(const id of input.resourceIds)await resource(id);
     if(input.secretIds!==undefined&&(!Array.isArray(input.secretIds)||input.secretIds.length>100))fail('grant_rules_invalid');
     for(const id of input.secretIds??[])active(await secret(id));
     rules={resourceIds:[...new Set(input.resourceIds)],secretIds:[...new Set(input.secretIds??[])],operations:[...new Set(input.operations)],workId:input.workId,maximumSpendMicroUsd:'0',spending:'No paid resource creation; paid worker execution uses its separate existing project allowance.'};
    }
    const value=kind==='broker-grant'?'claus_'+id+'.'+newSecretValue():newSecretValue();
    prepared={id,name:input.name,kind,rules,version:1,revision:1,status:'active',createdAt:stamp(),updatedAt:stamp(),expiresAt:input.expiresAt??null,sealed:seal(value,id+':1'),lastAction:actionId};
   }else if(operation==='secret_rotate'||operation==='secret_revoke'){
    const s=await secret(input.secretId);if(input.expectedRevision!==s.revision)fail('revision_conflict');
    if(operation==='secret_rotate'){active(s);const version=s.version+1,value=s.kind==='database-connection'?database.connection(s.resourceId,newSecretValue()):s.kind==='broker-grant'?'claus_'+s.id+'.'+newSecretValue():newSecretValue();prepared={...s,version,revision:s.revision+1,sealed:seal(value,s.id+':'+version),lastAction:actionId,updatedAt:stamp()};}
    else prepared={...s,status:'revoked',revision:s.revision+1,lastAction:actionId,updatedAt:stamp()};
   }else if(operation==='bind_secret'){
    const r=await resource(input.resourceId),s=await secret(input.secretId);active(s);envName(input.envName);
    if(r.provider!=='vercel'||input.version!==s.version)fail('binding_invalid');
    const prior=await store.get('binding',r.id+':'+input.envName),envs=await providers.envs(r),found=envs.find(e=>e.key===input.envName&&e.target?.includes('production'));
    if(found&&!prior)fail('existing_environment_not_managed');
    prepared={resource:r,secretId:s.id,version:s.version,sealed:s.sealed,envName:input.envName,priorEnv:found?{id:found.id}:null,priorBinding:prior};
   }else if(operation==='settings'){
    const r=await resource(input.resourceId);if(r.protected||r.provider!=='vercel')fail('settings_scope_denied');validateSettings(input.settings);prepared={resource:r};
   }else fail('operation_denied');
   const reservation=await store.begin(actionId,operation,input,prepared);prepared=reservation.row.result.prepared;
   if(reservation.row.result.output)return reservation.row.result.output;
  }
  const complete=result=>store.complete(actionId,{id:actionId,...result});
  if(operation==='database_create'){
   const key=prepared.secret,connection=open(key.sealed,key.id+':1'),created=await database.provision(prepared.id,connection);
   const stored=await store.put('secret',key.id,key);if(stored.value.lastAction!==actionId)fail('secret_conflict');await store.put('secret-version',key.id+':1',key);
   const r={id:prepared.id,name:prepared.name,purpose:prepared.purpose,provider:'postgresql',providerId:created.role,owner:'Claus',kind:'managed-database-schema',database:created.database,schema:created.schema,connectionSecretId:key.id,revision:1,createdAt:stamp(),creationAction:actionId};
   const saved=await store.put('resource',r.id,r);return complete({resource:metadata(saved.value),secret:secretMetadata(key),next:'Bind the connection secret to an owned application. It owns this isolated schema; use database_migrate and database_schema to manage tables and indexes. Shared extensions include vector and pg_trgm.'});
  }
  if(operation==='database_migrate'){const r=prepared.resource;return complete(await database.migrate(r.id,await databaseConnection(r),actionId,prepared.sourceHash,input.plan));}
  if(operation==='secret_create'||operation==='grant_create'){
   const r=await store.put('secret',prepared.id,prepared);if(r.value.lastAction!==actionId)fail('secret_conflict');
   await store.put('secret-version',prepared.id+':'+prepared.version,prepared);
   return complete({secret:secretMetadata(prepared),...(prepared.rules?{rules:prepared.rules}:{}),next:'Use bind_secret to assign this reference; no secret value is returned.'});
  }
  if(operation==='secret_rotate'||operation==='secret_revoke'){
   const s=await secret(prepared.id);
   if(prepared.kind==='database-connection')await database.credential(prepared.resourceId,open(prepared.sealed,prepared.id+':'+prepared.version),input.expectedRevision,operation==='secret_revoke',actionId);
   if(s.lastAction!==actionId)await store.change('secret',s.id,input.expectedRevision,prepared);
   await store.put('secret-version',prepared.id+':'+prepared.version,prepared);
   const bindings=(await all('binding')).filter(b=>b.secretId===prepared.id).map(b=>({resourceId:b.resourceId,envName:b.envName,version:b.version}));
   return complete({secret:secretMetadata(prepared),bindings,...(prepared.kind==='database-connection'?{databaseAuthenticationChanged:true,existingDatabaseSessionsTerminated:false}:{}),brokerGrantRevoked:prepared.kind==='broker-grant'&&prepared.status==='revoked',next:operation==='secret_rotate'?'Bind the new version to each application and deploy it.':'New bindings and broker authentication are revoked immediately. Previously deployed application values remain until the application replaces/removes them and deploys.'});
  }
  if(operation==='project_create'||operation==='repository_create'){
   let r=await providers.find(prepared.provider,prepared.name);
   if(!r&&await store.dispatch(actionId))r=await providers.create(prepared.provider,prepared.name,input);
   if(!r)return {id:actionId,state:'outcome_unknown',retry:false,next:'Keep this request ID and reconcile; do not create a replacement project.'};
   const id='res_'+digest([r.provider,r.providerId]).slice(0,24),saved={...r,id,kind:'managed-project',revision:1,purpose:input.purpose,createdAt:stamp(),creationAction:actionId};
   const stored=await store.put('resource',id,saved);return complete({resource:metadata(stored.value),runningComputeCreated:false});
  }
  if(operation==='bind_secret'){
   const s=await secret(prepared.secretId);active(s);
   const value=open(prepared.sealed,prepared.secretId+':'+prepared.version),r=prepared.resource;
   let envs=await providers.envs(r),found=envs.find(e=>e.key===prepared.envName&&e.target?.includes('production'));
   let matched=found&&await providers.envValue(r,found.id)===value;
   if(!matched&&await store.dispatch(actionId)){
    if(found&&found.id!==prepared.priorEnv?.id)fail('environment_changed');
    await providers.setEnv(r,prepared.envName,value,found);
    envs=await providers.envs(r);found=envs.find(e=>e.key===prepared.envName&&e.target?.includes('production'));matched=found&&await providers.envValue(r,found.id)===value;
   }
   if(!matched)return {id:actionId,state:'outcome_unknown',retry:false};
   const key=r.id+':'+prepared.envName,prior=await store.get('binding',key);
   const binding={resourceId:r.id,secretId:s.id,version:prepared.version,envName:prepared.envName,status:'bound',revision:(prior?.revision??0)+1,updatedAt:stamp(),lastAction:actionId};
   if(prior?.lastAction!==actionId){if(prior)await store.change('binding',key,prior.revision,binding);else await store.put('binding',key,binding);}
   await store.put('binding-history',actionId,binding);
   return complete({resourceId:r.id,secretId:s.id,version:prepared.version,envName:prepared.envName,bound:true,requiresDeployment:true});
  }
  if(operation==='settings'){
   let current=await providers.readSettings(prepared.resource,Object.keys(input.settings));
   if(!same(current,input.settings)&&await store.dispatch(actionId)){await providers.settings(prepared.resource,input.settings);current=await providers.readSettings(prepared.resource,Object.keys(input.settings));}
   if(!same(current,input.settings))return {id:actionId,state:'outcome_unknown',retry:false};
   return complete({resourceId:prepared.resource.id,settings:current,requiresDeployment:true});
  }
 }
 return {call,authorization};
}
