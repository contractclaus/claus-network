import {createHmac,createHash,timingSafeEqual} from 'node:crypto';
import {amount,canonical,digest,requireThat} from '../src/shared/index.mjs';

const ORIGIN='https://claus-ecosystem-payments.vercel.app';
const wire=(profile,request)=>({model:profile.model,provider:'openai',stream:false,store:false,
  reasoning:{effort:'low',context:'all_turns'},max_output_tokens:request.maxOutputTokens,
  input:[{role:'user',content:request.input}]});
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function inferencePorts({env=process.env,fetcher=fetch,now=()=>Date.now()}={}) {
  const secret=env.CLAUS_COMPUTE_SECRET,model=env.CLAUS_COMPUTE_MODEL;
  const configured=typeof secret==='string'&&secret.length>=32&&/^gpt-[a-z0-9.-]+$/.test(model??'');
  const enabled=configured&&env.CLAUS_COMPUTE_ENABLED==='1';
  function compatible(p) {
    requireThat(configured&&p.providerId==='surplus'&&p.accountId==='claus-network-x402-v1'&&p.model===model&&
      p.providers.length===1&&p.providers[0]==='openai'&&p.asset==='base-usdc-micro'&&
      p.maxOutputTokens<=4096&&amount(p.maximumPerRequest)<=2000000n,'inference_profile_not_supported');
  }
  const mac=value=>'sha256:'+createHmac('sha256',secret).update(canonical(value)).digest('hex');
  const unsigned=q=>{const {proofHash,...v}=q;return v;};
  const id=p=>'network-compute:'+p.requestId.replace(/^sha256:/,'');
  async function json(path,options={}) {
    const res=await fetcher(ORIGIN+path,{...options,redirect:'error',signal:AbortSignal.timeout(options.method==='POST'?200000:20000),
      headers:{authorization:'Bearer '+secret,...options.headers}});
    const raw=await res.text();requireThat(Buffer.byteLength(raw)<=1000000,'compute_response_too_large');
    if(!res.ok){const error=Object.assign(Error('compute_provider_unavailable'),{status:res.status});throw error;}
    return JSON.parse(raw);
  }
  function expectedHash(p) {
    return createHash('sha256').update(p.quote.maximum+'\n'+JSON.stringify(wire(p.profile,p.request))).digest('hex');
  }
  async function observe(p) {
    compatible(p.profile);
    const value=await json('/api/compute/'+id(p));
    requireThat(value.id===id(p)&&value.requestHash===expectedHash(p),'compute_receipt_binding_mismatch');
    const response=value.response,choice=response?.choices?.[0];
    const complete=value.status==='completed'&&response?.model===p.profile.model&&choice?.finish_reason==='stop'&&typeof choice?.message?.content==='string'&&!choice.message.tool_calls?.length;
    const result={providerRequestId:id(p),work:complete?'completed':['failed','completed'].includes(value.status)?'failed':'unknown'};
    if(complete)result.output={model:p.profile.model,text:choice.message.content};
    if(value.accounting?.final===true){
      const a=value.accounting;
      requireThat(amount(a.amount)<=amount(a.maximum)&&amount(a.maximum)<=amount(p.quote.maximum)&&/^sha256:[a-f0-9]{64}$/.test(a.proofHash),'compute_cost_mismatch');
      result.receipt={effectKey:p.effectKey,requestHash:p.requestHash,profileHash:digest(p.profile),quoteId:p.quote.id,
        providerId:p.profile.providerId,accountId:p.profile.accountId,providerRequestId:id(p),asset:p.profile.asset,
        actual:a.amount,final:true,proofHash:a.proofHash};
    }
    return result;
  }
  return {enabled,
    provider:{
      async quote({profile,requestHash}) {
        compatible(profile);
        const q={id:digest({profile:digest(profile),requestHash}),providerId:profile.providerId,accountId:profile.accountId,
          asset:profile.asset,requestHash,profileHash:digest(profile),maximum:profile.maximumPerRequest,
          expiresAt:Math.min(profile.expiresAt??Infinity,now()+30*60000)};
        return {...q,proofHash:mac(q)};
      },
      async dispatch(p) {
        compatible(p.profile);
        try {await json('/api/completion',{method:'POST',headers:{'content-type':'application/json','idempotency-key':id(p),'x-max-quote-micro-usdc':p.quote.maximum},body:JSON.stringify(wire(p.profile,p.request))});}
        catch { /* The original ID is reconciled even if its response was lost. */ }
        return observe(p);
      },
      reconcile:observe
    },
    async verifyQuote(q,profile) {compatible(profile);return equal(mac(unsigned(q)),q.proofHash);},
    async verifyReceipt(receipt,v) {
      // Re-read the saved payer result; never trust model output or inline cost.
      const p={...v,requestId:v.id,effectKey:receipt.effectKey,request:await v.loadRequest?.()};
      // Request payload is supplied by the caller below through its artifact store.
      if(!p.request)return false;
      const current=await observe(p);return current.receipt&&digest(current.receipt)===digest(receipt);
    }
  };
}
