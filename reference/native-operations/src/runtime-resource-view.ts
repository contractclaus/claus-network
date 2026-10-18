const amount=(v:unknown)=>typeof v==='string'&&/^\d{1,80}$/.test(v)?BigInt(v):null;
const time=(v:unknown):number|null=>Number.isSafeInteger(v)&&(v as number)>0?v as number:null;
const text=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=240;
const active=(r:any)=>r.desired==='running'&&r.terminal===false;
const key=(projectId:string,profileId:string)=>JSON.stringify([projectId,profileId]);
const validResource=(r:any)=>r&&text(r.id)&&text(r.projectId)&&text(r.profileId)&&text(r.state)&&text(r.desired)&&typeof r.terminal==='boolean';

export function runtimeResourceView(resources:any,profiles:any,now=Date.now()){
 if(resources?.available!==true)return {state:'unavailable',complete:false,fundingComplete:false,nextProjectCursor:null,items:null,reason:resources?.error??resources?.reason??'resource_read_unavailable'};
 const value=resources.value;
 if(!Array.isArray(value?.items))return {state:'unavailable',complete:false,fundingComplete:false,nextProjectCursor:null,items:null,reason:'resource_response_invalid'};
 const items=value.items.filter(validResource),invalidItems=value.items.length-items.length;
 const grants=new Map<string,any>(),duplicates=new Set<string>();
 for(const entry of profiles?.available===true&&Array.isArray(profiles.value?.items)?profiles.value.items:[]){
  const g=entry?.allowance;
  if(!g||!text(g.projectId)||!text(g.profileId)||entry.profile?.id!==g.profileId)continue;
  const id=key(g.projectId,g.profileId);
  if(grants.has(id))duplicates.add(id);else grants.set(id,g);
 }
 const observedProjects=new Set<string>(profiles?.value?.observedProjects??[]);
 const fleet=Object.hasOwn(value,'complete');
 const complete=invalidItems===0&&(fleet
  ?value.complete===true&&value.nextProjectCursor===null&&Array.isArray(value.resourceCursors)&&value.resourceCursors.length===0&&Array.isArray(value.unavailable)&&value.unavailable.length===0
  :value.nextCursor===null);
 const projected=items.map((r:any)=>{
  const id=key(r.projectId,r.profileId),grant=duplicates.has(id)?null:grants.get(id);
  const limit=amount(grant?.limit),reserved=amount(grant?.reserved),spent=amount(grant?.spent);
  const remaining=limit!==null&&reserved!==null&&spent!==null?limit-reserved-spent:null;
  const grantExpiry=time(grant?.expiresAt),expiry=time(r.leaseUntil),providerExpiry=time(r.providerLeaseUntil),maintenance=r.maintenance??null,issues:string[]=[];
  const fundingStatus=grant&&remaining!==null&&(grant.expiresAt===null||grantExpiry!==null)&&typeof grant.enabled==='boolean'?'available'
   :!grant&&!duplicates.has(id)&&observedProjects.has(r.projectId)?'unassigned':active(r)?'unavailable':'unknown';
  if(active(r)){
   if(r.renewalPending)issues.push('provider_extension_not_confirmed');
   if(r.state!=='running')issues.push('resource_not_ready');
   if(expiry!==null&&expiry<=now)issues.push('resource_lease_expired');
   if(providerExpiry!==null&&providerExpiry<=now)issues.push('provider_lease_expired');
   if(fundingStatus==='unavailable')issues.push('allowance_observation_unavailable');
   if(fundingStatus==='unassigned')issues.push('allowance_not_assigned');
   if(grantExpiry!==null&&grantExpiry<=now)issues.push('allowance_expired');
   if(remaining!==null&&remaining<=0n)issues.push('existing_allowance_exhausted');
   if(grant?.enabled===false)issues.push('allowance_disabled');
   const maintenanceUntil=time(maintenance?.until),ceiling=amount(maintenance?.maxTotalCost),committed=amount(r.cost?.maximum);
   const blocked=maintenance?.last?.state==='blocked';
   const deadline=maintenance!==null&&maintenance.until!==null&&(maintenanceUntil===null||maintenanceUntil<=now||expiry!==null&&maintenanceUntil-expiry<60000);
   const exhausted=ceiling!==null&&committed!==null&&committed>=ceiling;
   if(blocked)issues.push(text(maintenance.last.code)?maintenance.last.code:'maintenance_blocked');
   if(deadline)issues.push('maintenance_deadline_reached');
   if(exhausted)issues.push('maintenance_budget_exhausted');
   const effectiveExpiry=expiry===null?providerExpiry:providerExpiry===null?expiry:Math.min(expiry,providerExpiry);
   if(effectiveExpiry!==null&&effectiveExpiry-now<3600000&&(!maintenance||blocked||deadline||exhausted||grant?.enabled===false||grantExpiry!==null&&grantExpiry<=now||remaining!==null&&remaining<=0n))issues.push('lease_expiring_without_maintenance');
  }
  return {id:r.id,projectId:r.projectId,profileId:r.profileId,state:r.state,desired:r.desired,terminal:r.terminal,endpoint:r.endpoint??null,leaseUntil:expiry,providerLeaseUntil:providerExpiry,renewalPending:r.renewalPending===true,maintenance,fundingStatus,remainingGrantUnits:remaining===null?null:String(remaining),grantExpiresAt:grantExpiry,issues:[...new Set(issues)]};
 });
 return {state:'available',complete,invalidItems,observedAt:now,nextCursor:value.nextCursor??null,
  ...(fleet?{nextProjectCursor:value.nextProjectCursor??null,resourceCursors:value.resourceCursors??null,unavailable:value.unavailable??null}:{}),
  fundingComplete:projected.filter(active).every((r:any)=>r.fundingStatus==='available'||r.fundingStatus==='unassigned'),
  items:projected,meaning:'Actual assigned infrastructure and existing funding only. A configured maintenance policy is not a provider-confirmed renewal. Unknown billing remains reserved. No new resource or spending permission is created.'};
}

// Inspect funding only for active resources already returned by the bounded fleet read.
// These authenticated reads inspect existing grants; they never purchase or top up.
export async function loadRuntimeResourceView(call:(name:string,input:any)=>Promise<any>,now=Date.now()){
 let value:any;
 try{value=await call('resource_fleet',{limit:10});}
 catch{return runtimeResourceView({available:false,reason:'resource_read_unavailable'},{available:false},now);}
 if(!Array.isArray(value?.items))return runtimeResourceView({available:true,value},{available:false},now);
 const projects=[...new Set<string>(value.items.filter(validResource).filter(active).map((r:any)=>r.projectId))].slice(0,10);
 const reads=await Promise.all(projects.map(async projectId=>{
  try{
   const result=await call('resource_profiles',{projectId});
   if(!Array.isArray(result?.items)||result.items.some((x:any)=>x?.allowance?.projectId!==projectId||!text(x?.allowance?.profileId)||x.profile?.id!==x.allowance.profileId))return null;
   return {projectId,items:result.items};
  }catch{return null;}
 }));
 const observed=reads.filter((r):r is NonNullable<typeof r>=>r!==null);
 return runtimeResourceView({available:true,value},{available:true,value:{observedProjects:observed.map(r=>r.projectId),items:observed.flatMap(r=>r.items)}},now);
}

export function runtimeAttentionSignature(view:any){
 return {state:view?.state??'unavailable',complete:view?.complete===true,fundingComplete:view?.fundingComplete===true,items:(Array.isArray(view?.items)?view.items:[]).map((r:any)=>({id:r.id,projectId:r.projectId,state:r.state,desired:r.desired,terminal:r.terminal,renewalPending:r.renewalPending,fundingStatus:r.fundingStatus,issues:r.issues??[]})).sort((a:any,b:any)=>String(a.id).localeCompare(String(b.id)))};
}
