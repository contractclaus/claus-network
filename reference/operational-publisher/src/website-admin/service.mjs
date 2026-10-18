import {DNS_TYPES,dnsBody,dnsView,dnsMatches,dnsName} from './dns.mjs';
import {websiteAssets} from './assets.mjs';
import {hash,target} from '../publisher/policy.js';
import {OperationsHost} from '../publisher/host.js';
import {websiteDatabase,migrationStatements} from './database.mjs';
const fail=code=>{throw Error('website_'+code);};
const domain=value=>{if(typeof value!=='string'||value.length>253||! /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*claus\.si$/.test(value))fail('domain_outside_owner_scope');return value;};
const envName=value=>{if(typeof value!=='string'||!/^(?:SITE_|NEXT_PUBLIC_|VITE_|PUBLIC_)[A-Z][A-Z0-9_]{0,100}$/.test(value)||/(?:SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|DATABASE_URL|API_KEY)/.test(value))fail('environment_name_denied');return value;};
const domainView=d=>({name:d.name,verified:d.verified===true,redirect:d.redirect??null,redirectStatusCode:d.redirectStatusCode??null,verification:d.verification??[]});
const envView=e=>({id:e.id,key:e.key,type:e.type,target:e.target,updatedAt:e.updatedAt??null});
export function validateWebsitePlan(plan){
 if(!plan||plan.version!==1||typeof plan.reason!=='string'||!plan.reason.trim()||plan.reason.length>2400)fail('plan_invalid');
 if(plan.kind==='database'){migrationStatements(plan);return;}
 if(plan.kind==='domain'){domain(plan.name);if(!['set','remove','verify'].includes(plan.operation))fail('plan_invalid');if(plan.redirect!==undefined&&plan.redirect!==null)domain(plan.redirect);if(plan.redirect===plan.name)fail('redirect_loop');if(plan.redirectStatusCode!==undefined&&![301,302,307,308].includes(plan.redirectStatusCode))fail('redirect_invalid');return;}
 if(plan.kind==='environment'){envName(plan.key);if(!['set','remove'].includes(plan.operation)||plan.operation==='set'&&(typeof plan.value!=='string'||plan.value.length>16000))fail('plan_invalid');return;}
 if(plan.kind==='dns'){dnsBody(plan);return;}
 fail('plan_kind_invalid');
}
export function createWebsiteAdmin({repository,ledger,host=new OperationsHost(),database=websiteDatabase(),request=fetch,dnsConfig=()=>({token:process.env.WEBSITE_CLOUDFLARE_TOKEN,zone:process.env.WEBSITE_CLOUDFLARE_ZONE})}){
 const assets=websiteAssets({ledger});
 const project=target('web').project;
 const call=(path,method='GET',body)=>host.api(path,{method,...(body?{body:JSON.stringify(body)}:{})},'web');
 const domains=async()=> (await call('/v9/projects/'+project+'/domains')).domains.map(domainView);
 const environments=async()=> (await call('/v10/projects/'+project+'/env')).envs.filter(e=>e.target?.includes('production')).map(envView);
 const cf=async(path,method='GET',body)=>{const c=dnsConfig();if(!c.token||! /^[a-f0-9]{32}$/.test(c.zone??''))fail('dns_not_connected');const r=await request('https://api.cloudflare.com/client/v4/zones/'+c.zone+path,{method,headers:{authorization:'Bearer '+c.token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(20000)});const v=await r.json();if(!r.ok||v.success!==true)fail('dns_provider_error');return v;};
 const dns=async()=>{const out=[];for(let page=1;page<=10;page++){const v=await cf('/dns_records?per_page=100&page='+page);out.push(...v.result.map(dnsView));if(page>=(v.result_info?.total_pages??1))return out;}fail('dns_inventory_incomplete');};
 async function enabled(){const c=await repository.current('web');if(!c?.enabled||!(await repository.settings()).enabled)fail('disabled');return c;}
 async function planAt(path,expectedRevision){const c=await enabled();if(c.revision!==expectedRevision)fail('revision_conflict');if(typeof path!=='string'||!/^operations\/website\/[a-z0-9_-]+\.json$/.test(path))fail('plan_path_invalid');const file=c.manifest.find(f=>f.path===path);if(!file||file.size>100000)fail('plan_missing');await host.baseline('web',c.deployment,c.manifest);const plan=JSON.parse(await host.read('web',c.deployment,file));validateWebsitePlan(plan);return {plan,path,sourceHash:file.sha,deployment:c.deployment,revision:c.revision};}
 async function observe(plan){if(plan.kind==='domain')return {items:await domains()};if(plan.kind==='environment')return {items:await environments()};if(plan.kind==='dns')return {items:await dns()};return database.inspect();}
 async function matched(saved,id){const p=saved.plan;if(p.kind==='database')return database.recover('website:'+saved.sourceHash,saved.sourceHash);
  const v=await observe(p);if(p.kind==='domain'){const d=v.items.find(x=>x.name===p.name);if(p.operation==='remove')return !d?{applied:true,domain:p.name,removed:true}:null;if(p.operation==='verify')return d?.verified?{applied:true,domain:d}:null;return d&&(d.redirect??null)===(p.redirect??null)&&(d.redirectStatusCode??null)===(p.redirect?(p.redirectStatusCode??307):null)?{applied:true,domain:d}:null;}
  if(p.kind==='dns'){const d=p.id?v.items.find(x=>x.id===p.id):v.items.find(x=>dnsMatches(p,x));if(p.operation==='remove')return !d?{applied:true,removed:true,id:p.id}:null;return dnsMatches(p,d)?{applied:true,record:d}:null;}
  const e=v.items.find(x=>x.key===p.key);if(p.operation==='remove')return !e?{applied:true,key:p.key,removed:true,requiresDeployment:true}:null;
  if(!e)return null;const full=await call('/v1/projects/'+project+'/env/'+e.id);return full.value===p.value?{applied:true,key:p.key,id:e.id,requiresDeployment:true}:null;
 }
 async function execute(saved,id){const p=saved.plan,prior=saved.before;
  if(p.kind==='database')return database.apply('website:'+saved.sourceHash,saved.sourceHash,p);
  if(p.kind==='domain'){const old=prior.items.find(x=>x.name===p.name);if(p.operation==='remove'){if(old)await call('/v9/projects/'+project+'/domains/'+encodeURIComponent(p.name),'DELETE');}else if(p.operation==='verify'){await call('/v9/projects/'+project+'/domains/'+encodeURIComponent(p.name)+'/verify','POST',{});}else{const body={name:p.name,redirect:p.redirect??null,redirectStatusCode:p.redirect?(p.redirectStatusCode??307):null};await call('/'+(old?'v9':'v10')+'/projects/'+project+'/domains'+(old?'/'+encodeURIComponent(p.name):''),old?'PATCH':'POST',body);}}
  else if(p.kind==='environment'){const old=prior.items.find(x=>x.key===p.key);if(old&&!/^(?:SITE_|NEXT_PUBLIC_|VITE_|PUBLIC_)/.test(old.key))fail('environment_name_denied');if(p.operation==='remove'){if(old)await call('/v9/projects/'+project+'/env/'+old.id,'DELETE');}else{await call('/'+(old?'v9':'v10')+'/projects/'+project+'/env'+(old?'/'+old.id:''),old?'PATCH':'POST',{key:p.key,value:p.value,type:'plain',target:['production']});}}
  else if(p.kind==='dns'){if(p.operation==='remove')await cf('/dns_records/'+p.id,'DELETE');else await cf('/dns_records'+(p.id?'/'+p.id:''),p.id?'PUT':'POST',dnsBody(p));}
  return matched(saved,id);
 }
 return {async call(operation,input,requestId){
  const c=await enabled();
  if(operation==='stage_asset')return assets.stage(input,requestId);
  if(operation==='asset')return assets.read(input.id);
  if(operation==='status')return {website:'https://claus.si',revision:c.revision,deployment:c.deployment,sourceFiles:c.manifest.length,plans:'operations/website/<name>.json in an active reviewed website release',hosting:true,dnsConnected:!!dnsConfig().token,dnsZone:'claus.si',dnsTypes:DNS_TYPES,dnsUnderscores:true,dnsWildcards:true,databaseConnected:!!process.env.WEBSITE_DATABASE_URL,databaseSchema:'claus_website',environmentPrefixes:['SITE_','NEXT_PUBLIC_','VITE_','PUBLIC_'],keysExposed:false};
  if(operation==='domains')return {items:await domains()};if(operation==='environment')return {items:await environments()};if(operation==='dns')return {items:await dns()};if(operation==='database')return database.inspect();
  if(operation==='recover'){if(typeof input.id!=='string'||!/^website:[a-f0-9]{64}$/.test(input.id))fail('action_id_invalid');const old=await ledger.get(input.id);if(!old)fail('action_missing');if(old.status==='completed')return {id:input.id,...old.result};if(!old.result?.plan)fail('outcome_unknown');const result=await matched(old.result,input.id);if(result){await ledger.complete(input.id,{...result,sourceHash:old.result.sourceHash,at:new Date().toISOString()});return {id:input.id,...result};}return {id:input.id,state:'outcome_unknown',retry:false};}
  if(operation!=='apply')fail('operation_denied');
  const saved=await planAt(input.path,input.expectedRevision),id='website:'+hash(requestId);saved.before=await observe(saved.plan);
  if(saved.plan.kind==='dns'&&saved.plan.id){const row=saved.before.items.find(r=>r.id===saved.plan.id);if(!row||dnsName(row.name)!==dnsName(saved.plan.name)||row.type!==saved.plan.type)fail('dns_record_binding');}
  const value=await ledger.reserveOci(id,{path:saved.path,sourceHash:saved.sourceHash,requestId},saved);
  if(!value.created){if(value.row.status==='completed')return{id,...value.row.result};const result=await matched(value.row.result,id);if(result){await ledger.complete(id,result);return{id,...result};}return{id,state:'outcome_unknown',retry:false};}
  const result=await execute(saved,id);if(!result)return {id,state:'pending',next:'Recover this original id; do not create another request.'};const completed={...result,sourceHash:saved.sourceHash,path:saved.path,at:new Date().toISOString()};await ledger.complete(id,completed);return{id,...completed};
 }};
}
