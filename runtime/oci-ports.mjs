import {canonical,requireThat} from '../src/shared/index.mjs';
import {createHmac,timingSafeEqual} from 'node:crypto';

export function ociPorts({env=process.env,request=fetch}={}){
  const secret=env.CRON_SECRET;
  if(!secret)return {enabled:false,ports:{}};
  const call=async(operation,work)=>{
    const response=await request('https://claus-inference.vercel.app/api/oci-builds',{method:'POST',redirect:'error',signal:AbortSignal.timeout(40000),headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:JSON.stringify({operation,work})});
    const raw=await response.text();requireThat(Buffer.byteLength(raw)<=64000&&response.ok,'oci_broker_unavailable');
    return JSON.parse(raw).result;
  };
  const valid=(expected,proof)=>typeof proof==='string'&&/^[a-f0-9]{64}$/.test(proof)&&timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(proof,'hex'));
  return {enabled:env.CLAUS_OCI_BUILDS_ENABLED==='1',ports:{
    dispatch:work=>call('dispatch',work),inspect:work=>call('inspect',work),
    async verifyObservation(work,observation){
      const {observationProof,proof,...result}=observation;
      return valid(createHmac('sha256',secret).update(canonical({work,result})).digest('hex'),observationProof);
    },
    async verify(receipt,result){
      const expected=createHmac('sha256',secret).update(canonical({receipt,runUrl:result.runUrl})).digest('hex');
      return valid(expected,result.proof);
    }
  }};
}
