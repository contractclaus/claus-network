import {canonical,requireThat} from '../src/shared/index.mjs';
import {createHmac,timingSafeEqual} from 'node:crypto';

export function infrastructurePorts({env=process.env,request=fetch}={}){
  const secret=env.CRON_SECRET,receipts=new WeakSet();
  if(!secret)return {enabled:false,ports:{}};
  const call=async(operation,input)=>{
    const response=await request('https://claus-inference.vercel.app/api/infrastructure',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(70000),
      headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:JSON.stringify({operation,input})
    });
    const raw=await response.text();requireThat(Buffer.byteLength(raw)<=64000,'infrastructure_response_too_large');
    let body;try{body=JSON.parse(raw);}catch{requireThat(false,'infrastructure_broker_unavailable');}
    requireThat(response.ok,/^infrastructure_[a-z0-9_]+$/.test(body.error??'')?body.error:'infrastructure_broker_unavailable');
    requireThat(body.result&&typeof body.result==='object','infrastructure_response_invalid');
    const {proof,...result}=body.result;
    const expected=createHmac('sha256',secret).update(canonical({operation,input,result})).digest('hex');
    requireThat(typeof proof==='string'&&/^[a-f0-9]{64}$/.test(proof)&&timingSafeEqual(Buffer.from(proof,'hex'),Buffer.from(expected,'hex')),'infrastructure_proof_invalid');
    if(result.receipt)receipts.add(result.receipt);
    return result;
  };
  const work=w=>({id:w.id,projectId:w.projectId,profile:w.profile,manifest:w.manifest,quote:w.quote,createdAt:w.createdAt,leaseUntil:w.leaseUntil,extensions:w.extensions??[]});
  return {enabled:env.CLAUS_INFRASTRUCTURE_ENABLED==='1',ports:{
    readiness:()=>call('readiness',{}),
    inspectOwnedBuild:input=>call('inspect_owned_build',input),
    fundingHistory:input=>call('funding_history',input),
    verifyRelease:async input=>(await call('verify_release',input)).approved===true,
    quote:input=>call('quote',input),
    create:w=>call('create',work(w)),inspect:w=>call('inspect',work(w)),extend:w=>call('extend',work(w)),
    stop:w=>call(w.desired==='deleted'?'delete':'stop',work(w)),
    logs:async w=>(await call('logs',work(w))).content,
    cost:async w=>(await call('cost',work(w))).costObservation,
    verifyReceipt:async(_w,receipt)=>receipts.has(receipt)
  }};
}
