import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request as httpsRequest} from 'node:https';
import {createGunzip,createInflate,createBrotliDecompress} from 'node:zlib';
import {researchUrl,researchRedirect} from './research-policy.js';

export function publicAddress(address:string) {
  if(isIP(address)!==4)return false;
  const [a,b,c]=address.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0&&(c===0||c===2)||b===88&&c===99)||a===100&&b>=64&&b<=127||a===198&&([18,19].includes(b)||b===51&&c===100)||a===203&&b===0&&c===113);
}

async function untilAbort<T>(operation:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted){operation.catch(()=>{});throw signal.reason;}
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    operation.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}

// The same deadline and validated, pinned address apply to every hop. These are
// credential-free GETs only; this reader cannot acquire new execution authority.
export function publicReader({resolve=lookup,request=httpsRequest}:any={}){
 return async function read(raw:string,{limit,timeoutMs,headers={},contentType,redirects=0,validateTarget}:{limit:number;timeoutMs:number;headers?:Record<string,string>;contentType:(headers:any,url:string)=>string;redirects?:number;validateTarget?:string}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isSafeInteger(redirects)||redirects<0||redirects>3)throw Error('invalid_source_request');
  const controller=new AbortController(),signal=controller.signal;
  const timer=setTimeout(()=>controller.abort(Error('source_timeout')),timeoutMs);
  try{
   const target=async (raw:string)=>{
    const url=researchUrl(raw),addresses:any=await untilAbort(Promise.resolve(resolve(url.hostname,{all:true,family:4})),signal);
    if(!addresses.length||addresses.some((a:any)=>!publicAddress(a.address)))throw Error('private_address_refused');
    return {url,addresses};
   };
   if(validateTarget)await target(validateTarget);
   let url=researchUrl(raw);
   for(let hop=redirects;hop<=3;hop++){
    const {addresses}=await target(url.href);
    const res:any=await untilAbort(new Promise((resolveResponse,reject)=>{
     const req=request(url,{family:4,signal,headers:{'User-Agent':'ClausResearch/1.0 (+https://claus.si)','Accept-Encoding':'gzip, deflate, br',...headers},lookup:(_host:any,_opts:any,cb:any)=>cb(null,addresses[0].address,4)},resolveResponse);
     req.on('error',reject);req.end();
    }),signal);
    if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){
     res.destroy();if(hop===3)throw Error('redirect_limit');
     url=researchUrl(researchRedirect(res.headers.location,url));continue;
    }
    let body:any=res;
    const stop=()=>{res.destroy(signal.reason);if(body!==res)body.destroy(signal.reason);};
    const propagate=(error:Error)=>{if(body!==res)body.destroy(error);};
    res.on('error',propagate);signal.addEventListener('abort',stop,{once:true});
    try{
     signal.throwIfAborted();
     if(res.statusCode!==200)throw Error(`source_http_${res.statusCode}`);
     const type=contentType(res.headers,url.href);
     const declared=res.headers['content-length'];
     if(declared!==undefined&&(!/^\d+$/.test(String(declared))||Number(declared)>limit))throw Error('source_too_large');
     const encoding=String(res.headers['content-encoding']??'identity').trim().toLowerCase();
     if(encoding==='gzip')body=createGunzip();
     else if(encoding==='deflate')body=createInflate();
     else if(encoding==='br')body=createBrotliDecompress();
     else if(encoding!=='identity')throw Error('unsupported_source_encoding');
     let wireBytes=0,decodedBytes=0;const chunks:Buffer[]=[];
     res.on('data',(chunk:Buffer)=>{wireBytes+=chunk.length;if(wireBytes>limit)res.destroy(Error('source_too_large'));});
     if(body!==res)res.pipe(body);
     for await(const chunk of body){decodedBytes+=chunk.length;if(decodedBytes>limit)throw Error('source_too_large');chunks.push(Buffer.from(chunk));}
     signal.throwIfAborted();
     if(res.complete!==true||declared!==undefined&&Number(declared)!==wireBytes)throw Error('source_incomplete');
     return {url:url.href,type,bytes:Buffer.concat(chunks)};
    }finally{
     signal.removeEventListener('abort',stop);res.destroy();if(body!==res)body.destroy();
    }
   }
   throw Error('redirect_limit');
  }finally{clearTimeout(timer);}
 };
}
export const readPublicBytes=(...args:Parameters<ReturnType<typeof publicReader>>)=>publicReader()(...args);
