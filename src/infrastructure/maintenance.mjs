import {amount,copy,digest,integer,requireThat,shape} from '../shared/index.mjs';

export function maintenancePolicy(input,{now,resource,profile,grant}) {
  if(input===null)return null;
  shape(input,['until','leaseSeconds','renewBeforeSeconds','maxTotalCost']);
  requireThat(resource.desired==='running'&&!resource.terminal&&resource.manifest.mode!=='job','maintenance_service_required');
  if(input.until===null)requireThat(grant.expiresAt===null,'maintenance_expiring_grant');else integer(input.until,Math.max(now+60000,resource.leaseUntil),grant.expiresAt??Number.MAX_SAFE_INTEGER);
  integer(input.leaseSeconds,60,profile.maxLeaseSeconds);
  integer(input.renewBeforeSeconds,60,Math.min(1800,Math.floor(input.leaseSeconds/2)));
  if(input.maxTotalCost!==null)requireThat(amount(input.maxTotalCost)>=amount(resource.reservedMaximum??resource.quote.maximum)&&amount(input.maxTotalCost)<=amount(grant.limit),'maintenance_budget_invalid');
  const policy=copy(input);
  return {...policy,policyHash:digest(policy),configuredAt:now,last:null,nextCheckAt:Math.max(now,resource.leaseUntil-input.renewBeforeSeconds*1000)};
}

export function maintenanceDue(resource,now,maxLeaseSeconds) {
  const p=resource.maintenance;
  if(!p||(p.until!==null&&p.until<=now)||resource.terminal||resource.desired!=='running'||resource.manifest.mode==='job')return {due:false,state:p?'inactive':'disabled'};
  if(resource.state!=='running'||resource.renewalPending||resource.leaseUntil<=now)return {due:false,state:'waiting_for_existing_resource'};
  const when=Math.max(p.nextCheckAt??0,resource.leaseUntil-p.renewBeforeSeconds*1000);
  if(when>now)return {due:false,state:'scheduled',nextCheckAt:when};
  const seconds=Math.floor(Math.min(p.leaseSeconds*1000,(p.until===null?Infinity:p.until-resource.leaseUntil),now+maxLeaseSeconds*1000-resource.leaseUntil)/1000);
  return seconds<60?{due:false,state:'deadline_reached'}:{due:true,seconds,policyHash:p.policyHash,leaseUntil:resource.leaseUntil};
}
