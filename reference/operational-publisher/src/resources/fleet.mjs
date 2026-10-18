import {providerRequest} from '../infrastructure/providers.mjs';
const fail=c=>{throw Error('resource_fleet_'+c);};
const id=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v);
const stamp=v=>Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000?new Date(v).toISOString():null;
export const fleetInputs={fleet_inventory:['provider','cursor','app'],fleet_leases:['offset']};
export function classifyFleet(machine,records,now=Date.now()){
 const matches=records.filter(r=>r.provider===machine.provider&&(r.providerResourceId===machine.id||machine.originalResourceId&&r.originalResourceId===machine.originalResourceId||machine.provider==='runpod'&&machine.name==='claus-'+r.originalResourceId?.slice(-40)));
 if(matches.length!==1)return {...machine,binding:matches.length?'ambiguous':'unmapped',originals:matches.map(x=>x.originalResourceId),next:matches.length?'Inspect retained original records; do not stop by name alone.':'Recover the original owner, work and data-retention plan before changing this resource.'};
 const r=matches[0],consistent=!!machine.image&&r.image===machine.image&&(!r.providerResourceId||r.providerResourceId===machine.id)&&(machine.provider==='runpod'?machine.name==='claus-'+r.originalResourceId?.slice(-40):machine.projectId===r.projectId&&machine.app===r.app);
 const expired=Number.isSafeInteger(r.leaseUntil)&&r.leaseUntil<=now;
 const binding=!consistent?'metadata-mismatch':r.terminal&&!machine.terminal?'terminal-record-still-present':!r.providerResourceId?'original-create-unreconciled':'managed';
 return {...machine,binding,originalResourceId:r.originalResourceId,projectId:r.projectId,originalOperationId:r.id,leaseUntil:stamp(r.leaseUntil),leaseExpired:expired,recordedState:r.state,observedAt:stamp(r.observedAt),data:{networkVolume:r.networkVolume??null,durableState:'Inspect the original manifest, worker checkpoints and published assets; provider-local disk alone is not a backup.'},next:binding==='managed'?expired?'The existing original-resource guardian must reconcile expiry; inspect that original resource.':'Use original infrastructure inspect/stop/delete and its existing budget and data rules.':'Inspect and reconcile this original resource before any replacement or deletion.'};
}
export function managedFleet({store,environment=process.env,request=fetch,now=Date.now}){
 const api=(origin,path,token)=>{if(!token)fail('provider_not_configured');return providerRequest(request,origin+path,token);};
 const project=(p,provider,app=null)=>{
  if(!id(p.id))fail('provider_shape');
  const image=provider==='runpod'?p.image:p.config?.image,original=p.config?.metadata?.claus_resource,projectId=p.config?.metadata?.claus_project;
  const state=provider==='runpod'?p.status:p.state;
  return {provider,id:p.id,name:typeof p.name==='string'?p.name.slice(0,200):null,state:typeof state==='string'?state.slice(0,100):null,image:typeof image==='string'&&/^[a-z0-9][a-zA-Z0-9./:_-]{0,500}@sha256:[a-f0-9]{64}$/.test(image)?image:null,app,terminal:provider==='runpod'?p.status==='TERMINATED':p.state==='destroyed',originalResourceId:provider==='fly'&&/^sha256:[a-f0-9]{64}$/.test(original??'')?original:null,projectId:provider==='fly'&&/^prj_[a-zA-Z0-9_-]{1,100}$/.test(projectId??'')?projectId:null};
 };
 async function correlate(machines){const originals=await store.infrastructureMatches(machines);return machines.map(m=>classifyFleet(m,originals,now()));}
 return {async call(operation,input){
  if(operation==='fleet_leases'){
   const offset=input.offset??0;if(!Number.isSafeInteger(offset)||offset<0)fail('page_invalid');const page=await store.infrastructureLeases(offset);
   return {...page,items:page.items.map(r=>({...r,leaseExpired:Number.isSafeInteger(r.leaseUntil)&&r.leaseUntil<=now(),providerObservationIsCurrent:false})),readOnly:true,meaning:'Retained original broker records. Provider inventory is read separately; an old observation does not prove the machine is still running.'};
  }
  if(operation!=='fleet_inventory'||!['runpod','fly'].includes(input.provider))fail('provider_invalid');
  if(input.cursor!==undefined&&(typeof input.cursor!=='string'||!input.cursor.length||input.cursor.length>4000)||input.app!==undefined&&(typeof input.app!=='string'||!/^[a-z0-9][a-z0-9-]{2,62}$/.test(input.app)))fail('page_invalid');
  let items,nextCursor=null;
  if(input.provider==='runpod'){
   if(input.app!==undefined)fail('app_invalid');
   const page=await api('https://api.runpod.io/v2','/pods?limit=100'+(input.cursor?'&cursor='+encodeURIComponent(input.cursor):''),environment.CLAUS_RUNPOD_API_KEY);
   if(!Array.isArray(page.pods)||page.pods.length>100||typeof page.pagination?.hasNextPage!=='boolean'||page.pagination.hasNextPage&&(typeof page.pagination.nextCursor!=='string'||!page.pagination.nextCursor.length||page.pagination.nextCursor.length>4000||page.pagination.nextCursor===input.cursor))fail('provider_shape');
   items=await correlate(page.pods.map(p=>project(p,'runpod')));nextCursor=page.pagination.hasNextPage?page.pagination.nextCursor:null;
  }else{
   if(input.cursor!==undefined)fail('cursor_invalid');
   const token=environment.CLAUS_FLY_API_TOKEN,origin='https://api.machines.dev/v1';
   if(!input.app){
    const result=await api(origin,'/apps?org_slug=claus-network',token);if(!Array.isArray(result.apps)||result.apps.length>1000)fail('provider_shape');
    return {provider:'fly',applications:result.apps.map(a=>({name:a.name,network:a.network??null})),next:'Call fleet_inventory with provider=fly and each returned app to inspect its machines.',allMachinesInspected:result.apps.length===0,observedAt:new Date(now()).toISOString(),readOnly:true};
   }
   const app=await api(origin,'/apps/'+encodeURIComponent(input.app),token);if(app.organization?.slug!=='claus-network')fail('account_mismatch');
   const machines=await api(origin,'/apps/'+encodeURIComponent(input.app)+'/machines?include_deleted=true',token);if(!Array.isArray(machines)||machines.length>1000)fail('provider_shape');
   items=await correlate(machines.map(m=>project(m,'fly',input.app)));
  }
  return {provider:input.provider,app:input.app??null,items,nextCursor,pageComplete:nextCursor===null,observedAt:new Date(now()).toISOString(),readOnly:true,providerChanges:0,meaning:'Actual provider inventory compared with retained original resource identities. Unmapped or conflicting resources are observations, never permission for blind deletion. Existing idle/work rules and the resource guardian retain responsibility for safe stopping and data retention.'};
 }};
}
