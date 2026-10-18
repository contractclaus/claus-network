import {digest} from './store.mjs';
const fail=c=>{throw Error('resource_catalog_'+c);};
export const catalogInputs={capabilities:[],capability_record:['name','description','provider','resourceIds','operations','billing','limitations','recovery','evidence','expectedRevision'],blockers:['offset'],blocker_record:['name','workId','provider','reason','requiredAction','independentWorkIds','retryAt','resolved','evidence','expectedRevision']};
const clean=(v,max=1200)=>{if(typeof v!=='string'||!v.trim()||v.length>max||/-----BEGIN|Bearer\s|(?:token|secret|password|api[-_]?key)\s*[=:]\s*\S{8}/i.test(v))fail('text_invalid');return v;};
const array=(v,max=50)=>{if(!Array.isArray(v)||v.length>max||v.some(x=>typeof x!=='string'||x.length>200))fail('list_invalid');return v;};
export function resourceCatalog({store,providers,workStatus=async()=>null,now=Date.now}){
 const builtins=()=>[
  {name:'durable-request-queues',provider:'Claus',configured:true,scope:'Existing work and a pinned registered endpoint; authenticated JSON webhook intake',operations:['create queue','enqueue with dependencies','inspect failed requests','cancel before dispatch','pause','resume original receipt','webhook binding'],billing:'Each original endpoint request uses its existing shared budget admission; HTTP 202 is acceptance, not external completion',expiresAt:null,recovery:'Durable job IDs, encrypted arguments, original endpoint action IDs, CAS request leases and bounded reconciliation'},
  {name:'owned-build-runners',provider:'GitHub',configured:providers.configured().github,scope:'contractclaus managed repositories; immutable source and workflow references',operations:['install controlled workflow','start AMD64/ARM64 Linux build','reuse dependency or container cache','inspect jobs and artifacts','read logs','cancel original build'],billing:'Current runner price plus headroom and artifact allowance reserved under the shared operating budget; no duplicate automatic dispatch; retained artifacts expire after one day',expiresAt:null,recovery:'Original action, run, source and workflow IDs retained; private image pulls require a package read credential'},
  {name:'owned-projects',provider:'Vercel',configured:providers.configured().vercelProjectCreation,scope:'AGENT team; mutations through managed resource references',operations:['create project','build settings','encrypted environment','stage pinned source','promote tracked deployment','logs'],billing:'Basic build authorization USD0.50; variable hosting usage requires separate attribution',expiresAt:null,recovery:'Encrypted goal-completion archive; owner can revoke the team token'},
  {name:'owned-repositories',provider:'GitHub',configured:providers.configured().github,scope:'contractclaus managed repositories',operations:['create repository','inspect immutable source','write expected file revision','create branch'],billing:'Existing account; no new subscription created',expiresAt:null,recovery:'Private source archive and retained public Git history'},
  {name:'application-databases',provider:'Neon',configured:providers.configured().database,scope:'Isolated per-application roles and schemas in claus_applications',operations:['provision schema and role','migrate','inspect','rotate/revoke connection','vector and trigram extensions'],billing:'Existing Neon account; shared database service usage',expiresAt:null,recovery:'Application database backups; role keys retained encrypted'},
  {name:'object-storage',provider:'Cloudflare R2',configured:!!process.env.RESOURCE_R2_ACCESS_KEY,scope:'Claus Network; broker restricts managed buckets and object references',operations:['create private bucket','retention policy','multipart upload','resumable full SHA256 verification','private download','delete object','delete empty bucket'],billing:'Full retention-period authorization before upload; R2 Standard pricing; authorization is not invoice',expiresAt:null,recovery:'Encrypted credentials; provider retention acts independently of main agent'},
  {name:'website-dns',provider:'Cloudflare',configured:providers.configured().cloudflareDns,scope:'claus.si zone',operations:['read and update zone records through manage_website'],billing:'Existing DNS service',expiresAt:null,recovery:'Retained website and DNS change history'},
  {name:'gpu-and-cpu-runtime',provider:'Runpod',configured:providers.configured().runpod,scope:'Enrolled infrastructure profiles and original leases',operations:['quote','create','inspect','stop','delete','renew','logs','GPU count and VRAM selection'],billing:'Shared USD200/24h and USD6000/30d; authenticated Runpod top-up receipts separately recorded',expiresAt:null,recovery:'Existing guardian and retained original operation IDs'},
  {name:'second-runtime-provider',provider:'Fly.io',configured:!!process.env.CLAUS_FLY_API_TOKEN,scope:'claus-network organization; per-project isolated apps',operations:['postpaid profile readiness','live shape pricing','isolated apps','original machine lifecycle','transfer metering and stop guard'],billing:'Existing card billing; shared operating authorization; metering delay can overshoot estimates and final invoice remains separate',expiresAt:null,recovery:'Encrypted token and immutable image references'}
 ];
 return {
  async observe(provider,value){const old=await store.get('identity-observation',provider),v={provider,value,at:new Date(now()).toISOString(),revision:(old?.revision??0)+1,evidenceKind:'authenticated-provider-response'};if(old)await store.change('identity-observation',provider,old.revision,v);else await store.put('identity-observation',provider,v);},
  async call(operation,input){
   if(operation==='capabilities'){
    const custom=[];let offset=0;do{const p=await store.list('capability',offset);custom.push(...p.items);offset=p.nextOffset;}while(offset!==null);
    const observations=(await store.list('identity-observation')).items;
    const procedures=await store.list('procedure');
    return {version:1,observedAt:new Date(now()).toISOString(),builtins:builtins().map(v=>({...v,configurationIsNotExecutionProof:true,lastEvidence:observations.find(o=>o.provider.toLowerCase()===v.provider.toLowerCase())??null})),custom,procedures:procedures.items.filter(p=>p.status==='active').map(p=>({name:p.name,revision:p.revision,summary:p.summary,terms:p.terms,bodyHash:p.bodyHash,instructionAuthority:false})),nextProcedureOffset:procedures.nextOffset,policy:{operatingUsdRolling24h:200,operatingUsdRolling30d:6000,separateMandates:['jobs','investment','trade-program gas'],ownerRevocation:true,capabilityRecordsDoNotGrantPermissions:true},missingEvidence:'null expiry means unknown/not recorded, not infinite lifetime; configured means a credential is present, not that every action succeeded'};
   }
   if(operation==='blockers'){const offset=input.offset??0;if(!Number.isSafeInteger(offset)||offset<0)fail('offset_invalid');return store.list('blocker',offset);}
   clean(input.name,100);if(!/^[a-z][a-z0-9-]{1,99}$/.test(input.name)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)fail('reference_invalid');
   const kind=operation==='capability_record'?'capability':'blocker',key=input.name,old=await store.get(kind,key);
   const fields={...input};delete fields.expectedRevision;
   if(kind==='capability'){
    clean(input.description);clean(input.provider,100);clean(input.billing);clean(input.limitations);clean(input.recovery);clean(input.evidence);array(input.operations);array(input.resourceIds);
    for(const id of input.resourceIds){if(id==='website')continue;if(!await store.get('resource',id))fail('resource_unknown');}
   }else{
    if(!/^nw_[a-z0-9_-]{1,80}$/.test(input.workId??'')||!await workStatus(input.workId))fail('work_unknown');
    clean(input.provider,100);clean(input.reason);clean(input.requiredAction);clean(input.evidence);array(input.independentWorkIds);for(const id of input.independentWorkIds)if(!/^nw_[a-z0-9_-]{1,80}$/.test(id)||id===input.workId||!await workStatus(id))fail('independent_work_unknown');
    if(!/^nw_[a-z0-9_-]{1,80}$/.test(input.workId??'')||typeof input.resolved!=='boolean'||input.retryAt!==null&&!Number.isFinite(Date.parse(input.retryAt)))fail('blocker_invalid');
   }
   if(old?.requestHash===digest(fields))return old;
   if((old?.revision??0)!==input.expectedRevision)fail('revision_conflict');
   const value={...fields,revision:input.expectedRevision+1,updatedAt:new Date(now()).toISOString(),evidenceKind:'agent-recorded-reference',requestHash:digest(fields),grantsPermissions:false};
   if(old)await store.change(kind,key,old.revision,value);else{const saved=await store.put(kind,key,value);if(saved.value.requestHash!==value.requestHash)fail('revision_conflict');}
   await store.put(kind+'-history',key+':'+value.revision,value);return value;
  }
 };
}
