import {ROUTES} from './contract.mjs';

export const DEFAULT_API_ORIGIN='https://claus-network-api.vercel.app';

export class ClausNetworkError extends Error {
 constructor(code,status,details){super(code);this.name='ClausNetworkError';this.code=code;this.status=status;this.details=details;this.retryAfterSeconds=details?.retryAfterSeconds;this.outcome=details?.outcome;}
}
export function createClient({origin=DEFAULT_API_ORIGIN,token,fetch:request=globalThis.fetch}={}){
 const base=new URL(origin);
 if(base.protocol!=='https:'&&!(base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname)))throw Error('HTTPS required');
 if(base.username||base.password||base.search||base.hash)throw Error('Invalid API origin');
 return {
  async call(name,input={},options={}){
   const route=ROUTES.find(r=>r.name===name);if(!route)throw Error('Unknown operation');
   options.signal?.throwIfAborted();
   const remaining={...input};
   const path=route.path.replace(/\{(\w+)\}/g,(_,key)=>{
    const value=remaining[key],numeric=route.inputSchema.properties[key]?.type==='integer';
    if(numeric?!Number.isSafeInteger(value)||value<0:typeof value!=='string'||!value)throw Error('Missing or invalid path parameter');
    delete remaining[key];return encodeURIComponent(String(value));
   });
   const url=new URL(path,base);const headers={accept:'application/json'};
   if(!route.public&&token)headers.authorization='Bearer '+(typeof token==='function'?await token():token);
   let body;
   if(route.method==='GET'){for(const [key,value] of Object.entries(remaining))if(value!==undefined)url.searchParams.set(key,Array.isArray(value)?JSON.stringify(value):String(value));}
   else if(Object.keys(remaining).length){headers['content-type']='application/json';body=JSON.stringify(remaining);}
   // Never automatically retry a mutation or forward credentials on redirects.
   options.signal?.throwIfAborted();
   const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000);
   const unknownOutcome=route.method==='GET'?'read_failed':'unknown';let response,result;
   try {
    response=await request(url,{method:route.method,headers,body,redirect:'error',signal});
    result=await response.json();
   } catch {
    const code=options.signal?.aborted?'request_aborted':signal.aborted?'request_timeout':response?'invalid_api_response':'transport_unavailable';
    throw new ClausNetworkError(code,response?.status??0,{error:code,category:'transport',outcome:unknownOutcome,automaticRetry:false});
   }
   if(!response.ok){
    const declared=response.headers.get('retry-after'),retry=Number.isSafeInteger(result?.retryAfterSeconds)&&result.retryAfterSeconds>0?Math.min(3600,result.retryAfterSeconds):/^\d{1,5}$/.test(declared??'')?Math.min(3600,Number(declared)):null;
    // A conflict can refer to an effect that already reached its provider.
    // HTTP 409 alone is not evidence that a mutation was rejected unsent.
    const uncertain=response.status>=500||result?.category==='unknown_outcome'||result?.outcome==='unknown'||result?.error==='effect_requires_reconciliation';
    const details={...(result&&typeof result==='object'&&!Array.isArray(result)?result:{}),outcome:route.method==='GET'?'read_failed':uncertain?'unknown':'rejected',automaticRetry:false,...(retry!==null?{retryAfterSeconds:retry}:{})};
    throw new ClausNetworkError(typeof result?.error==='string'?result.error:'request_failed',response.status,details);
   }
   return result;
  }
 };
}
