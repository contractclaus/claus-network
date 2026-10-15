import {amount} from '../shared/index.mjs';

// Snapshot only. Expired grants still own their original reservations and spend.
export async function computeUsage(reader,profile,at){
 let after='',allocated=0n,reserved=0n,spent=0n,expiredUnspent=0n,active=0,expired=0,grants=0;
 for(;;){
  const rows=await reader.list('inference-allowances',{after,limit:100});
  for(const {value:g}of rows){
   if(g.profileId!==profile.profileId)continue;
   const limit=amount(g.limit),hold=amount(g.reserved),used=amount(g.spent);
   allocated+=limit;reserved+=hold;spent+=used;grants++;
   if(g.enabled&&g.expiresAt>at)active++;
   else {expired++;if(limit>hold+used)expiredUnspent+=limit-hold-used;}
  }
  if(rows.length<100)break;after=rows.at(-1).id;
 }
 const consistent=allocated===amount(profile.allocated)&&reserved+spent<=allocated;
 return {observedAt:at,grants,active,expiredOrDisabled:expired,allocated:allocated.toString(),reserved:reserved.toString(),spent:spent.toString(),
  unspentAllocated:(allocated-reserved-spent).toString(),expiredUnspent:expiredUnspent.toString(),consistent,
  meaning:'Same-accounting-snapshot totals. Reserved includes unresolved original requests. Expiry never refunds spent funds or clears reservations. Expired unspent allocation can be reassigned only through an explicit grant update.'};
}
