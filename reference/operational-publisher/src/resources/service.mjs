import {validateRepositoryScopes,authorizeRepositoryScope} from './repository-grants.mjs';
import {managedRetirement,retirementInputs,assertResourcesActive} from './retirement.mjs';
import {accountCosts,costInputs} from './account-costs.mjs';
import {managedReleases,releaseInputs} from './repository-releases.mjs';
import {managedDomains,domainInputs} from './project-domains.mjs';
import {developmentFunding} from './development-funding.mjs';
import {managedVolumes,volumeInputs} from './volumes.mjs';
import {managedAssets,assetInputs} from './assets.mjs';
import {runtimeTuning,tuningInputs} from './runtime-tuning.mjs';
import {managedServices,serviceInputs} from './services.mjs';
import {managedProcedures,procedureInputs} from './procedures.mjs';
import {managedQueues,queueInputs} from './queues.mjs';
import {managedEndpoints,endpointInputs} from './endpoints.mjs';
import {managedBuilds,buildInputs} from './builds.mjs';
import {resourceCatalog,catalogInputs} from './catalog.mjs';
import {managedObjects,objectInputs} from './objects.mjs';
import {managedRepository} from './repository.mjs';
import {managedPublishing} from './publishing.mjs';
import {resourceBudget} from './budget.mjs';
import {resourceDatabase} from './database.mjs';
import {timingSafeEqual} from 'node:crypto';
import {resourceStore,digest,sameValue} from './store.mjs';
import {resourceProviders,team,validateSettings} from './providers.mjs';
import {sealSecret,openSecret,secretMetadata,newSecretValue} from './vault.mjs';
const fail=message=>{throw Error('resource_'+message);};
const ref=(value,prefix)=>{if(typeof value!=='string'||!new RegExp('^'+prefix+'_[a-f0-9]{24}$').test(value))fail('reference_invalid');return value;};
const safeName=value=>{if(typeof value!=='string'||! /^[a-z][a-z0-9-]{1,40}$/.test(value))fail('name_invalid');return value;};
const envName=value=>{if(typeof value!=='string'||! /^[A-Z][A-Z0-9_]{1,100}$/.test(value)||/^(?:NEXT_PUBLIC_|PUBLIC_|VITE_|VERCEL_|NODE_)/.test(value))fail('secret_environment_invalid');return value;};
const same=sameValue;
const website={id:'website',provider:'vercel',providerId:'prj_3EPhg3tuhf5oHU9sw2Butj9eRegy',name:'claus',owner:team,kind:'existing-website',protected:true};
const grantOperations=['repository_file','repository_write','endpoint_info','endpoint_invoke','endpoint_result','queue_info','queue_jobs','object_get','object_list','object_parts','object_upload','object_commit','object_download','resource','deployments','bindings','settings','bind_secret'];
const inputKeys={...retirementInputs,...costInputs,...releaseInputs,...domainInputs,development_fund:['actionId','vcpus','seconds'],...volumeInputs,...assetInputs,...tuningInputs,...serviceInputs,...procedureInputs,...queueInputs,...endpointInputs,...catalogInputs,...objectInputs,repository_file:['resourceId','path','ref','offset'],repository_tree:['resourceId','commit'],repository_write:['resourceId','path','branch','content','encoding','expectedBlobSha','message'],repository_branch:['resourceId','branch','commit'],deployment_stage:['resourceId','repositoryId','commit','expectedDeploymentId'],deployment_promote:['resourceId','deploymentId','expectedDeploymentId','healthPath'],database_create:['name','purpose'],database_schema:['resourceId'],database_migrate:['resourceId','plan'],status:[],identity:['provider'],resources:['offset'],resource:['resourceId'],secrets:['offset'],bindings:['resourceId'],deployments:['resourceId'],logs:['resourceId','deploymentId'],action:['id'],project_create:['name','purpose'],repository_create:['name','purpose','private'],secret_create:['name','expiresAt'],grant_create:['name','expiresAt','resourceIds','secretIds','operations','workId','maximumSpendMicroUsd','repositoryScopes'],secret_rotate:['secretId','expectedRevision'],secret_revoke:['secretId','expectedRevision'],bind_secret:['resourceId','secretId','version','envName'],settings:['resourceId','settings']};
export function createResourceService({objects=null,repository=null,publishing=null,budget=resourceBudget(),database=resourceDatabase(),store=resourceStore(),providers=resourceProviders(),seal=sealSecret,open=openSecret,now=Date.now,environment=process.env,workStatus=async()=>null}={}){
 const retirement=managedRetirement({store,providers,now,invoke:(operation,input,requestId)=>call(operation,input,requestId,{retiring:true})});
 const costs=accountCosts({store,env:environment,now});
 const releases=managedReleases({store,call:providers.call,now});
 const domains=managedDomains({store,call:providers.call,now});
 const developmentFund=developmentFunding({store,budget,now});
 const volumes=managedVolumes({store,budget,workStatus,now});
 const assets=managedAssets({store,workStatus,now});
 const tuning=runtimeTuning({store,workStatus,now});
 const services=managedServices({store,providers,open,workStatus,now,invoke:(...args)=>call(...args)});
 const builds=managedBuilds({store,providers,budget,now,environment});
 const endpoints=managedEndpoints({store,budget,seal,open,now,workStatus});
 const procedures=managedProcedures({store,workStatus,now});
 const queues=managedQueues({store,endpoints,workStatus,open,now});
 const catalog=resourceCatalog({store,providers,workStatus,now});
 objects??=managedObjects({store,budget,seal,open,now});
 repository??=managedRepository({call:providers.call});
 publishing??=managedPublishing({call:providers.call,repository,store,budget});
 async function resource(id){if(id==='website')return website;ref(id,'res');const v=await store.get('resource',id);if(!v)fail('not_found');return v;}
 async function secret(id){ref(id,'sec');const v=await store.get('secret',id);if(!v)fail('secret_not_found');return v;}
 async function databaseConnection(r){const s=await secret(r.connectionSecretId);active(s);return open(s.sealed,s.id+':'+s.version);}
 async function all(kind){const out=[];let offset=0;for(;;){const p=await store.list(kind,offset);out.push(...p.items);if(p.nextOffset===null)return out;offset=p.nextOffset;}}
 const active=s=>{if(s.status!=='active'||s.expiresAt&&Date.parse(s.expiresAt)<=now())fail('secret_inactive');};
 const stamp=()=>new Date(now()).toISOString();
 const metadata=r=>({id:r.id,provider:r.provider,providerId:r.providerId,name:r.name,owner:r.owner,url:r.url??null,private:r.private??null,kind:r.kind,status:r.status??'active',...(r.provider==='r2'?{retentionDays:r.retentionDays}:{}),revision:r.revision??1,createdAt:r.createdAt??null,...(r.provider==='postgresql'?{database:r.database,schema:r.schema,connectionSecretId:r.connectionSecretId}: {})});
 async function authorization(token,operation,input){
  const m=/^claus_(sec_[a-f0-9]{24})\.[a-zA-Z0-9_-]{43}$/.exec(token??'');if(!m)fail('grant_invalid');
  const s=await secret(m[1]);active(s);if(s.kind!=='broker-grant'||!s.rules?.operations.includes(operation)||!s.rules.resourceIds.includes(input.resourceId))fail('grant_scope_denied');
  authorizeRepositoryScope(s.rules,operation,input);
  if(input.secretId&&!s.rules.secretIds.includes(input.secretId))fail('grant_scope_denied');
  if(!['ready','working','waiting'].includes(await workStatus(s.rules.workId)))fail('grant_work_inactive');
  const bytes=Buffer.from(open(s.sealed,s.id+':'+s.version)),given=Buffer.from(token);if(bytes.length!==given.length||!timingSafeEqual(bytes,given))fail('grant_invalid');return {id:s.id,version:s.version};
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
 async function call(operation,input,requestId,{grant=null,retiring=false}={}){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('input_invalid');
  const keys=buildInputs[operation]??inputKeys[operation];
  if(!keys||Object.keys(input).some(k=>!keys.includes(k)))fail('input_invalid');
  const delegation=grant?await authorization(grant,operation,input):null,principal=delegation?.id??'owner';
  if(retirementInputs[operation]){if(grant)fail('grant_scope_denied');return retirement.call(operation,input,requestId);}
  const reads=new Set(['status','identity','resources','resource','secrets','bindings','deployments','logs','action','repository_file','repository_tree','database_schema','endpoint_info','endpoint_result','endpoint_reconcile','queue_info','queue_jobs','queue_run','queue_cancel','volume_info','volume_cost','object_get','object_list','object_parts','object_download']);
  if(!retiring&&!reads.has(operation))await assertResourcesActive(store,input);
  if(costInputs[operation])return costs(input);
  if(releaseInputs[operation])return releases.call(operation,input,requestId);
  if(domainInputs[operation])return domains.call(operation,input,requestId);
  if(operation==='development_fund')return developmentFund(input);
  if(volumeInputs[operation])return volumes.call(operation,input,requestId);
  if(assetInputs[operation])return assets.call(operation,input,requestId);
  if(tuningInputs[operation])return tuning.call(operation,input,requestId);
  if(serviceInputs[operation])return services.call(operation,input,requestId);
  if(procedureInputs[operation])return procedures.call(operation,input,requestId);
  if(queueInputs[operation])return queues.call(operation,input,requestId,seal);
  if(buildInputs[operation])return builds.call(operation,input,requestId);
  if(endpointInputs[operation])return endpoints.call(operation,input,requestId,delegation);
  if(catalogInputs[operation])return catalog.call(operation,input);
  if(objectInputs[operation])return objects.call(operation,input,requestId,principal);
  const offset=input.offset??0;if(!Number.isSafeInteger(offset)||offset<0)fail('offset_invalid');
  if(operation==='status')return {version:1,configured:{...providers.configured(),objectStorage:objects.configured()},scope:'Claus-owned projects, application secret references and revocable broker grants',website:metadata(website),operations:[...Object.keys(retirementInputs),...Object.keys(costInputs),...Object.keys(releaseInputs),...Object.keys(domainInputs),...Object.keys(volumeInputs),...Object.keys(assetInputs),...Object.keys(tuningInputs),...Object.keys(serviceInputs),...Object.keys(procedureInputs),...Object.keys(queueInputs),...Object.keys(buildInputs),...Object.keys(endpointInputs),...Object.keys(catalogInputs),...Object.keys(objectInputs),'repository_file','repository_tree','repository_write','repository_branch','deployment_stage','deployment_promote','resources','resource','identity','project_create','repository_create','database_create','database_schema','database_migrate','settings','deployments','logs','secrets','secret_create','secret_rotate','secret_revoke','grant_create','bind_secret','bindings','action'],providerBilling:'Project/repository creation does not reserve a running server. Deployment stages reserve USD0.50 per Basic build under the shared USD200/24h and USD6000/30d operating budget. This maximum authorization is not an invoice; compute leases retain their own recorded reservations.',secretValuesReturned:false};
  if(operation==='repository_file'||operation==='repository_tree'){const r=await resource(input.resourceId);return operation==='repository_file'?repository.repositoryFile(r,input):repository.repositoryTree(r,input.commit);}
  if(operation==='identity'){if(!['vercel','github'].includes(input.provider))fail('provider_invalid');const observation=await providers.identity(input.provider);await catalog.observe(input.provider,observation);return observation;}
  if(operation==='resources'){const p=await store.list('resource',offset);return {...p,items:p.items.map(metadata)};}
  if(operation==='database_schema'){const r=await resource(input.resourceId);if(r.provider!=='postgresql')fail('provider_invalid');const key=await secret(r.connectionSecretId);active(key);return database.inspect(r.id,open(key.sealed,key.id+':'+key.version));}
  if(operation==='resource'){const r=await resource(input.resourceId);return {...metadata(r),observation:r.kind==='managed-network-volume'?(await volumes.call('volume_info',{resourceId:r.id})):r.kind==='managed-queue'?await queues.call('queue_info',{resourceId:r.id}):r.provider==='http'?{state:r.status,endpoint:r.definition,configurationIsNotExecutionProof:true}:r.provider==='r2'?await objects.inspect(r):r.provider==='postgresql'?await database.inspect(r.id,await databaseConnection(r)):await providers.read(r),observedAt:stamp()};}
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
   if(operation==='repository_write'||operation==='repository_branch'){const r=await resource(input.resourceId);if(r.provider!=='github')fail('provider_invalid');prepared={resource:r};}
   else if(operation==='deployment_stage'){if(input.expectedDeploymentId!==null&&!/^dpl_[A-Za-z0-9]+$/.test(input.expectedDeploymentId??''))fail('expected_deployment_required');prepared=await publishing.prepare(await resource(input.resourceId),await resource(input.repositoryId),input);}
   else if(operation==='deployment_promote'){const r=await resource(input.resourceId);if(r.provider!=='vercel'||r.protected)fail('scope_denied');prepared={resource:r};}
   else if(operation==='project_create'||operation==='repository_create'){
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
     const maximum=input.maximumSpendMicroUsd??'0';
     if(typeof maximum!=='string'||!/^(0|[1-9][0-9]{0,8})$/.test(maximum)||BigInt(maximum)>200000000n)fail('grant_budget_invalid');
     const repositoryScopes=validateRepositoryScopes(input.repositoryScopes,input.resourceIds,input.operations);
     for(const scope of repositoryScopes){const r=await resource(scope.resourceId);if(r.provider!=='github'||r.defaultBranch===scope.branch)fail('grant_repository_scope');const branch=await providers.call('github','/repos/contractclaus/'+encodeURIComponent(r.name)+'/git/ref/heads/'+encodeURIComponent(scope.branch));if(!/^[a-f0-9]{40}$/.test(branch.object?.sha??''))fail('grant_repository_branch');}
     rules={repositoryScopes,resourceIds:[...new Set(input.resourceIds)],secretIds:[...new Set(input.secretIds??[])],operations:[...new Set(input.operations)],workId:input.workId,maximumSpendMicroUsd:maximum,spending:'Lifetime maximum exposure for explicitly scoped endpoint calls, also gated by the shared operating budget. Dispatched or unknown outcomes remain allocated. No financial rights or resource-creation authority.'};
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
  if(operation==='repository_write'||operation==='repository_branch'){const result=operation==='repository_write'?await repository.repositoryWrite(prepared.resource,input,actionId,()=>store.dispatch(actionId,delegation)):await repository.repositoryBranch(prepared.resource,input,()=>store.dispatch(actionId,delegation));return result.state==='outcome_unknown'?{id:actionId,...result}:complete(result);}
  if(operation==='deployment_stage'){const result=await publishing.stage(prepared,actionId,()=>store.dispatch(actionId,delegation));if(result.pending)return {id:actionId,...result};if(result.deployment)await store.put('publication',result.deployment.id,{...result,actionId,resourceId:prepared.resource.id,repositoryId:prepared.repository.id,at:stamp()});return complete(result);}
  if(operation==='deployment_promote'){const result=await publishing.promote(prepared.resource,input,actionId,()=>store.dispatch(actionId,delegation));return result.pending?{id:actionId,...result}:complete(result);}
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
   if(!r&&await store.dispatch(actionId,delegation))r=await providers.create(prepared.provider,prepared.name,input);
   if(!r)return {id:actionId,state:'outcome_unknown',retry:false,next:'Keep this request ID and reconcile; do not create a replacement project.'};
   const id='res_'+digest([r.provider,r.providerId]).slice(0,24),saved={...r,id,kind:'managed-project',revision:1,purpose:input.purpose,createdAt:stamp(),creationAction:actionId};
   const stored=await store.put('resource',id,saved);return complete({resource:metadata(stored.value),runningComputeCreated:false});
  }
  if(operation==='bind_secret'){
   const s=await secret(prepared.secretId);active(s);if(s.version!==prepared.version)fail('secret_version_changed');
   const value=open(prepared.sealed,prepared.secretId+':'+prepared.version),r=prepared.resource;
   let envs=await providers.envs(r),found=envs.find(e=>e.key===prepared.envName&&e.target?.includes('production'));
   let matched=found&&await providers.envValue(r,found.id)===value;
   if(!matched&&await store.dispatch(actionId,delegation)){
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
   if(!same(current,input.settings)&&await store.dispatch(actionId,delegation)){await providers.settings(prepared.resource,input.settings);current=await providers.readSettings(prepared.resource,Object.keys(input.settings));}
   if(!same(current,input.settings))return {id:actionId,state:'outcome_unknown',retry:false};
   return complete({resourceId:prepared.resource.id,settings:current,requiresDeployment:true});
  }
 }
 return {call,authorization,tickQueues:()=>queues.tick(),tickVolumes:()=>volumes.tick(),webhook:(id,input)=>queues.webhook(id,input,seal)};
}
