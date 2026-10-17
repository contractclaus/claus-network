import {canonical,digest,requireThat} from '../src/shared/index.mjs';
import {createHmac,timingSafeEqual} from 'node:crypto';

export function ociPorts({env=process.env,request=fetch}={}){
  const secret=env.CRON_SECRET;
  if(!secret)return {enabled:false,ports:{}};
  const call=async(operation,work)=>{
    const response=await request('https://claus-inference.vercel.app/api/oci-builds',{method:'POST',redirect:'error',signal:AbortSignal.timeout(40000),headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:JSON.stringify({operation,work})});
    const raw=await response.text();requireThat(Buffer.byteLength(raw)<=64000&&response.ok,'oci_broker_unavailable');
    return JSON.parse(raw).result;
  };
  return {enabled:env.CLAUS_OCI_BUILDS_ENABLED==='1',ports:{
    dispatch:work=>call('dispatch',work),inspect:work=>call('inspect',work),
    async verify(receipt,result){
      const expected=createHmac('sha256',secret).update(canonical({receipt,runUrl:result.runUrl})).digest('hex');
      return typeof result.proof==='string'&&result.proof.length===expected.length&&timingSafeEqual(Buffer.from(expected),Buffer.from(result.proof));
    }
  }};
}
