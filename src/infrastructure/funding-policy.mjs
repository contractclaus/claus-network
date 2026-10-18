import {amount,digest,requireThat} from '../shared/index.mjs';
import {reserve,settleReservation} from '../billing/index.mjs';
import {operatingProject} from '../operating-access/index.mjs';

export const postpaid=profile=>profile.billingMode==='postpaid';
export const grantExposure=(profile,grant)=>postpaid(profile)?0n:amount(grant.reserved)+amount(grant.spent);

// Postpaid authorization is not cash or a provider deposit. Original unsettled
// obligations stay visible; every dispatch still enters the shared custody gate.
async function move(tx,profile,reserved,invoiced){
  const id=digest({account:profile.fundingAccount,asset:profile.asset});
  const old=await tx.read('infrastructure-postpaid-obligations',id);
  const value=old?.value??{account:profile.fundingAccount,asset:profile.asset,billingMode:'postpaid',reserved:'0',invoiced:'0'};
  const next={...value,reserved:(amount(value.reserved)+reserved).toString(),invoiced:(amount(value.invoiced)+invoiced).toString()};
  amount(next.reserved);amount(next.invoiced);
  await tx.write('infrastructure-postpaid-obligations',id,next,old?.revision??0);
}
export async function reserveInfrastructure(tx,profile,projectId,maximum){
  if(!postpaid(profile))return reserve(tx,profile.fundingAccount,profile.asset,maximum);
  requireThat(await operatingProject(tx,projectId),'postpaid_owned_project_required');
  await move(tx,profile,amount(maximum),0n);
}
export async function settleInfrastructure(tx,profile,maximum,actual){
  if(!postpaid(profile))return settleReservation(tx,profile.fundingAccount,profile.asset,maximum,actual);
  requireThat(amount(actual)<=amount(maximum),'cost_exceeds_reservation');
  await move(tx,profile,-amount(maximum),amount(actual));
}
