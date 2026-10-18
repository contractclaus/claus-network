import {createHmac,timingSafeEqual} from 'node:crypto';
import {canonical,digest,amount,requireThat} from '../shared/index.mjs';
import {reserve,settleReservation} from '../billing/index.mjs';
export function volumeFundingHandler({store,secret=()=>process.env.CRON_SECRET,now=Date.now}){
 return async request=>{
  const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
  try{
   requireThat(request.method==='POST'&&typeof secret()==='string'&&secret().length>=24,'volume_funding_unauthorized');
   const timestamp=request.headers.get('x-claus-timestamp'),proof=request.headers.get('x-claus-volume-proof');
   requireThat(/^[0-9]{13}$/.test(timestamp??'')&&Math.abs(now()-Number(timestamp))<=300000&&/^[a-f0-9]{64}$/.test(proof??''),'volume_funding_unauthorized');
   const reader=request.body?.getReader();requireThat(reader,'volume_funding_input_invalid');let bytes=0;const parts=[];
   try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.length;requireThat(bytes<=4096,'volume_funding_input_invalid');parts.push(next.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   const raw=Buffer.concat(parts).toString('utf8');
   const expected=createHmac('sha256',secret()).update(timestamp+'.'+raw).digest('hex');requireThat(timingSafeEqual(Buffer.from(proof,'hex'),Buffer.from(expected,'hex')),'volume_funding_unauthorized');
   const input=JSON.parse(raw),{operation,id,resourceId,maximum,fundedUntil}=input;
   requireThat(Object.keys(input).sort().join()===['fundedUntil','id','maximum','operation','resourceId'].sort().join()&&['reserve','accept','cancel'].includes(operation)&&/^act_[a-f0-9]{24}$/.test(id??'')&&/^res_[a-f0-9]{24}$/.test(resourceId??'')&&typeof maximum==='string'&&/^[1-9][0-9]{0,8}$/.test(maximum)&&amount(maximum)<=200000000n&&Number.isFinite(Date.parse(fundedUntil)),'volume_funding_input_invalid');
   const result=await store.transaction(async tx=>{
    const old=await tx.read('infrastructure-volume-funding',id),definition={id,resourceId,maximum,fundedUntil},hash=digest(definition);
    if(old){requireThat(old.value.inputHash===hash,'volume_funding_request_conflict');
     if(operation==='reserve'){requireThat(old.value.state!=='cancelled','volume_funding_cancelled');return old.value;}
     if(operation==='accept'){
      requireThat(old.value.state!=='cancelled','volume_funding_cancelled');if(old.value.state==='accepted')return old.value;
      const value={...old.value,state:'accepted',acceptedAt:now()};await tx.write('infrastructure-volume-funding',id,value,old.revision);return value;
     }
     if(old.value.state==='cancelled')return old.value;
     requireThat(old.value.state==='reserved','volume_funding_already_accepted');await settleReservation(tx,old.value.fundingAccount,'USD',maximum,'0');
     const value={...old.value,state:'cancelled',cancelledAt:now()};await tx.write('infrastructure-volume-funding',id,value,old.revision);await tx.event({type:'infrastructure.volume_reservation_cancelled',id,resourceId,maximum,at:now()});return value;
    }
    if(operation==='cancel')return {...definition,state:'absent',reserved:false};
    requireThat(operation==='reserve','volume_funding_reservation_missing');
    const config=(await tx.read('infrastructure-funding','runpod'))?.value;
    requireThat(config?.enabled&&Date.parse(fundedUntil)>now()&&Date.parse(fundedUntil)<=now()+32*86400000,'volume_funding_unavailable');
    await reserve(tx,config.fundingAccount,'USD',maximum);
    const value={...definition,inputHash:hash,fundingAccount:config.fundingAccount,asset:'USD',state:'reserved',createdAt:now(),meaning:'Conservative volume obligation reserved from the existing funded pool. Acceptance is not an invoice and does not release the reservation.'};
    await tx.write('infrastructure-volume-funding',id,value,0);await tx.event({type:'infrastructure.volume_reserved',id,resourceId,maximum,at:now()});return value;
   });
   return json({result,proof:createHmac('sha256',secret()).update(canonical({input,result})).digest('hex')});
  }catch(e){const code=/^(volume_funding|funding)_[a-z0-9_]+$/.test(e?.code??'')?e.code:'volume_funding_unavailable';return json({error:code},code==='volume_funding_unauthorized'?401:409);}
 };
}
