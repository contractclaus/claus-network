import {digest,sameValue} from './store.mjs';
import {team} from './providers.mjs';
const fail=c=>{throw Error('resource_domain_'+c);};
const hostname=v=>typeof v==='string'&&v.length<=253&&v===v.toLowerCase()&&v.endsWith('.claus.si')&&v!=='www.claus.si'&&v.split('.').every(x=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x));
export const domainInputs={project_domain_info:['resourceId','domain'],project_domain_add:['resourceId','domain'],project_domain_verify:['resourceId','domain'],project_domain_remove:['resourceId','domain','expectedVersion']};
export function managedDomains({store,call,now=Date.now}){
 const api=(path,options)=>call('vercel',path,options);
 async function ownedHostname(name){
  if(hostname(name))return true;
  if(typeof name!=='string'||name.length>253||name!==name.toLowerCase()||!name.split('.').every(x=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x)))return false;
  const labels=name.split('.');for(let i=0;i<labels.length-1;i++){const record=await store.get('registrar-domain',labels.slice(i).join('.'));if(record?.status==='registered'&&record.owner===team)return true;}return false;
 }
 async function project(id){
  const r=await store.get('resource',id);if(!r||r.protected||r.provider!=='vercel'||r.owner!==team)fail('scope_invalid');
  const p=await api('/v9/projects/'+r.providerId);if(p.id!==r.providerId||p.accountId!==team)fail('owner_changed');return r;
 }
 function view(v){if(!v)return null;const body={domain:v.name,projectId:v.projectId,verified:v.verified===true,gitBranch:v.gitBranch??null,redirect:v.redirect??null,createdAt:v.createdAt??null,updatedAt:v.updatedAt??null};return {...body,version:digest(body),verification:(v.verification??[]).map(x=>({type:x.type,domain:x.domain,value:x.value})),meaning:'Hosting binding and ownership challenge. Verified ownership is not an independent TLS or application-health test.'};}
 async function current(r,name){const v=await api('/v9/projects/'+r.providerId+'/domains/'+encodeURIComponent(name),{missing:true});if(v&&(v.projectId!==r.providerId||v.name!==name))fail('provider_mismatch');return v;}
 async function change(operation,input,requestId){
  if(!await ownedHostname(input.domain))fail('outside_owned_subdomains');const r=await project(input.resourceId),name=input.domain;
  if(operation==='project_domain_info'){
   const v=await current(r,name);if(!v)return {exists:false,domain:name};
   const configuration=await api('/v6/domains/'+encodeURIComponent(name)+'/config?projectIdOrName='+encodeURIComponent(r.providerId));
   return {exists:true,...view(v),dns:configuration,managed:(await store.get('project-domain',name))?.resourceId===r.id,next:'Use the existing website DNS operation for the returned records. Keep unrelated records unchanged.'};
  }
  if(typeof requestId!=='string'||!requestId||requestId.length>200)fail('request_invalid');const id='act_'+digest(['owner',requestId]).slice(0,24);
  const prior=await store.get('action',id);if(prior&&(prior.operation!==operation||!sameValue(prior.input,input)))fail('request_conflict');if(prior?.output)return prior.output;
  let prepared=prior?.prepared;
  if(!prepared){
   const existing=await current(r,name),managed=await store.get('project-domain',name);
   if(managed&&managed.resourceId!==r.id)fail('other_project_binding');
   if(operation==='project_domain_add'){
    if(existing&&!managed)fail('existing_binding_not_managed');
    prepared={domain:name,existed:!!existing};
   }else{
    if(!managed||managed.resourceId!==r.id)fail('binding_not_managed');
    if(operation==='project_domain_remove'&&existing&&input.expectedVersion!==view(existing).version)fail('binding_changed');
    prepared={domain:name,before:existing?view(existing):null};
   }
   prepared=(await store.begin(id,operation,input,prepared)).row.result.prepared;
  }
  const complete=v=>store.complete(id,{id,resourceId:r.id,domain:name,...v});
  let v=await current(r,name);
  async function once(fn){
   if(!await store.dispatch(id))return;
   try{return await fn();}catch(e){if(e.status===429){e.retryAt=Math.max(now()+1000,e.retryAt??now()+300000);await store.deferRejected(id,new Date(e.retryAt).toISOString());}throw e;}
  }
  if(operation==='project_domain_add'){
   if(!v){await once(()=>api('/v10/projects/'+r.providerId+'/domains',{method:'POST',body:{name}}));v=await current(r,name);}
   if(!v)return {id,state:'outcome_unknown',retry:false};
   if(v.redirect||v.gitBranch)fail('unexpected_routing');
   const old=await store.get('project-domain',name),value={resourceId:r.id,domain:name,providerId:r.providerId,status:'active',creationAction:old?.creationAction??id,revision:(old?.revision??0)+1};
   if(old){if(old.resourceId!==r.id)fail('other_project_binding');if(old.status!=='active')await store.change('project-domain',name,old.revision,value);}
   else {const saved=await store.put('project-domain',name,value);if(saved.value.resourceId!==r.id)fail('other_project_binding');}
   return complete({binding:view(v),next:v.verified?'Read project_domain_info for current DNS targets.':'Apply the returned verification record through the existing DNS tool, then call project_domain_verify.'});
  }
  if(operation==='project_domain_verify'){
   if(!v)fail('binding_missing');
   if(!v.verified){
    try{await once(()=>api('/v9/projects/'+r.providerId+'/domains/'+encodeURIComponent(name)+'/verify',{method:'POST'}));}
    catch(e){if(e.status!==400)throw e;return complete({binding:view(await current(r,name)),state:'dns_proof_required'});}
    v=await current(r,name);
   }
   return v?.verified?complete({binding:view(v),state:'ownership_verified'}):{id,state:'verification_pending',binding:view(v),retry:false};
  }
  if(operation!=='project_domain_remove')fail('operation_invalid');
  if(v){
   if(view(v).version!==input.expectedVersion)fail('binding_changed');
   await once(()=>api('/v9/projects/'+r.providerId+'/domains/'+encodeURIComponent(name),{method:'DELETE',body:{removeRedirects:false}}));v=await current(r,name);
  }
  if(v)return {id,state:'outcome_unknown',retry:false};
  const old=await store.get('project-domain',name);if(old?.status==='active')await store.change('project-domain',name,old.revision,{...old,status:'removed',revision:old.revision+1,removedAt:now(),removalAction:id});
  return complete({state:'removed',dnsRecordsChanged:false,next:'Remove or repoint the corresponding DNS record by its original record ID if it is no longer needed.'});
 }
 return {call:change};
}
