const amount=(v:unknown)=>typeof v==='string'&&/^\d+$/.test(v)?BigInt(v):null;
export function runtimeResourceView(resources:any,profiles:any,now=Date.now()){
 if(resources?.available!==true)return {state:'unavailable',complete:false,items:null,reason:resources?.error??resources?.reason??'resource_read_unavailable'};
 const items=Array.isArray(resources.value?.items)?resources.value.items:[];
 const grants=new Map((profiles?.available===true&&Array.isArray(profiles.value?.items)?profiles.value.items:[]).map((x:any)=>[x.profile?.id,x.allowance]));
 return {state:'available',complete:resources.value?.nextCursor===null,nextCursor:resources.value?.nextCursor??null,observedAt:now,items:items.map((r:any)=>{
  const grant:any=grants.get(r.profileId),limit=amount(grant?.limit),reserved=amount(grant?.reserved),spent=amount(grant?.spent);
  const remaining=limit!==null&&reserved!==null&&spent!==null?limit-reserved-spent:null;
  const expiry=Number.isSafeInteger(r.leaseUntil)?r.leaseUntil:null,maintenance=r.maintenance??null,issues:string[]=[];
  if(r.renewalPending)issues.push('provider_extension_not_confirmed');
  if(maintenance?.last?.state==='blocked')issues.push(maintenance.last.code??'maintenance_blocked');
  if(r.desired==='running'&&!r.terminal&&expiry!==null&&expiry-now<3600000&&!maintenance)issues.push('lease_expiring_without_maintenance');
  if(r.desired==='running'&&!r.terminal&&r.state!=='running')issues.push('resource_not_ready');
  if(remaining!==null&&remaining<=0n)issues.push('existing_allowance_exhausted');
  if(grant&&grant.enabled===false)issues.push('allowance_disabled');
  return {id:r.id,profileId:r.profileId,state:r.state,desired:r.desired,terminal:r.terminal===true,endpoint:r.endpoint??null,leaseUntil:expiry,providerLeaseUntil:r.providerLeaseUntil??null,renewalPending:r.renewalPending===true,maintenance,remainingGrantUnits:remaining===null?null:String(remaining),grantExpiresAt:grant?.expiresAt??null,issues};
 }),meaning:'Actual assigned infrastructure and existing funding only. A configured maintenance policy is not a provider-confirmed renewal. Unknown billing remains reserved. No new resource or spending permission is created.'};
}

export function runtimeAttentionSignature(view:any){
 return {state:view?.state??'unavailable',complete:view?.complete===true,items:(Array.isArray(view?.items)?view.items:[]).map((r:any)=>({id:r.id,state:r.state,desired:r.desired,terminal:r.terminal,renewalPending:r.renewalPending,issues:r.issues??[]})).sort((a:any,b:any)=>String(a.id).localeCompare(String(b.id)))};
}
