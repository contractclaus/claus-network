import {canonical,requireThat} from '../src/shared/index.mjs';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {MAX_IMAGE_BYTES} from '../src/infrastructure/image-archive.mjs';

async function bounded(response,maximum){
  requireThat(!response.headers.get('content-length')||Number(response.headers.get('content-length'))<=maximum,'oci_response_too_large');
  const reader=response.body.getReader(),parts=[];let size=0;
  try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;requireThat(size<=maximum,'oci_response_too_large');parts.push(r.value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return Buffer.concat(parts);
}

export function ociPorts({env=process.env,request=fetch}={}){
  const secret=env.CRON_SECRET;
  if(!secret)return {enabled:false,ports:{}};
  const call=async(operation,work)=>{
    const response=await request('https://claus-inference.vercel.app/api/oci-builds',{method:'POST',redirect:'error',signal:AbortSignal.timeout(40000),headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:JSON.stringify({operation,work})});
    const data=JSON.parse((await bounded(response,64000)).toString());
    if(response.status===409&&data.error==='oci_result_expired')throw Object.assign(Error(data.error),{code:data.error});
    requireThat(response.ok,'oci_broker_unavailable');return data.result;
  };
  const valid=(expected,proof)=>typeof proof==='string'&&/^[a-f0-9]{64}$/.test(proof)&&timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(proof,'hex'));
  const verifyObservation=(work,observation)=>{
    const {observationProof,proof,...result}=observation;
    return valid(createHmac('sha256',secret).update(canonical({work,result})).digest('hex'),observationProof);
  };
  return {enabled:env.CLAUS_OCI_BUILDS_ENABLED==='1',ports:{
    dispatch:work=>call('dispatch',work),inspect:work=>call('inspect',work),
    async verifyObservation(work,observation){
      return verifyObservation(work,observation);
    },
    async download(work,receipt){
      const r=await call('download',work);
      requireThat(verifyObservation(work,r)&&r.buildId===work.id&&canonical(r.receipt)===canonical(receipt),'oci_image_download_unverified');
      const url=new URL(r.url);
      requireThat(url.protocol==='https:'&&!url.username&&!url.password&&['.blob.core.windows.net','.githubusercontent.com'].some(s=>url.hostname.endsWith(s)),'oci_image_redirect_invalid');
      const response=await request(url,{redirect:'error',signal:AbortSignal.timeout(90000)});
      requireThat(response.ok,'oci_image_download_unavailable');
      return bounded(response,MAX_IMAGE_BYTES+65536);
    },
    async verify(receipt,result){
      const expected=createHmac('sha256',secret).update(canonical({receipt,runUrl:result.runUrl})).digest('hex');
      return valid(expected,result.proof);
    }
  }};
}
