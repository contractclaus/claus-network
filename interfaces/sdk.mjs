import {ROUTES} from './contract.mjs';

export const DEFAULT_API_ORIGIN='https://claus-network-api.vercel.app';

export class ClausNetworkError extends Error {
 constructor(code,status,details){super(code);this.name='ClausNetworkError';this.code=code;this.status=status;this.details=details;}
}
export function createClient({origin=DEFAULT_API_ORIGIN,token,fetch:request=globalThis.fetch}={}){
 const base=new URL(origin);
 if(base.protocol!=='https:'&&!(base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname)))throw Error('HTTPS required');
 if(base.username||base.password||base.search||base.hash)throw Error('Invalid API origin');
 return {
  async call(name,input={},options={}){
   const route=ROUTES.find(r=>r.name===name);if(!route)throw Error('Unknown operation');
   const remaining={...input};
   const path=route.path.replace(/\{(\w+)\}/g,(_,key)=>{
    const value=remaining[key],numeric=route.inputSchema.properties[key]?.type==='integer';
    if(numeric?!Number.isSafeInteger(value)||value<0:typeof value!=='string'||!value)throw Error('Missing or invalid path parameter');
    delete remaining[key];return encodeURIComponent(String(value));
   });
   const url=new URL(path,base);const headers={accept:'application/json'};
   if(!route.public&&token)headers.authorization='Bearer '+(typeof token==='function'?await token():token);
   let body;
   if(route.method==='GET'){for(const [key,value] of Object.entries(remaining))if(value!==undefined)url.searchParams.set(key,String(value));}
   else if(Object.keys(remaining).length){headers['content-type']='application/json';body=JSON.stringify(remaining);}
   // Never automatically retry a mutation or forward credentials on redirects.
   const response=await request(url,{method:route.method,headers,body,redirect:'error',signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
   let result;
   try{result=await response.json();}
   catch{throw new ClausNetworkError('invalid_api_response',response.status,{error:'invalid_api_response'});}
   if(!response.ok)throw new ClausNetworkError(result.error??'request_failed',response.status,result);
   return result;
  }
 };
}
