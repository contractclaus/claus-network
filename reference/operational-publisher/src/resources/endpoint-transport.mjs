import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request as httpsRequest} from 'node:https';
const fail=c=>{throw Error('resource_endpoint_'+c);};
export function endpointUrl(raw){
 let u;try{u=new URL(raw);}catch{fail('url_invalid');}
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||u.search||!u.hostname.includes('.')||isIP(u.hostname)||/\.(?:local|localhost|internal|test|invalid)$/.test(u.hostname))fail('url_invalid');return u;
}
export function publicAddress(address){
 if(isIP(address)!==4)return false;const [a,b,c]=address.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0&&(c===0||c===2)||b===88&&c===99)||a===100&&b>=64&&b<=127||a===198&&([18,19].includes(b)||b===51&&c===100)||a===203&&b===0&&c===113);
}
export function endpointTransport({resolve=lookup,request=httpsRequest}={}){
 return async({url,method,headers,body,timeoutSeconds,maximumBytes})=>{
  const target=endpointUrl(url),signal=AbortSignal.timeout(timeoutSeconds*1000);
  const addresses=await new Promise((yes,no)=>{
   const abort=()=>no(Error('resource_endpoint_timeout'));signal.addEventListener('abort',abort,{once:true});
   Promise.resolve(resolve(target.hostname,{all:true,family:4})).then(yes,no).finally(()=>signal.removeEventListener('abort',abort));
  });
  if(!addresses.length||addresses.some(v=>!publicAddress(v.address)))fail('private_address');signal.throwIfAborted();
  const response=await new Promise((yes,no)=>{
   const req=request(target,{method,signal,family:4,lookup:(_host,_options,cb)=>cb(null,addresses[0].address,4),headers:{'user-agent':'Claus/1.0 (+https://claus.si)',accept:'application/json, text/plain','accept-encoding':'identity',...headers,...(body?{'content-type':'application/json','content-length':String(Buffer.byteLength(body))}:{})}},yes);
   req.on('error',no);req.end(body);
  });
  try{
   const declared=response.headers['content-length'];if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>maximumBytes))fail('response_size');
   if(response.headers['content-encoding']&&response.headers['content-encoding']!=='identity')fail('response_encoding');
   const type=String(response.headers['content-type']??'').split(';')[0].toLowerCase();
   if(!['application/json','application/problem+json','text/plain'].includes(type)&&!/^application\/[a-z0-9.+-]+\+json$/.test(type))fail('response_type');
   const parts=[];let bytes=0;for await(const part of response){bytes+=part.length;if(bytes>maximumBytes)fail('response_size');parts.push(part);}
   signal.throwIfAborted();if(!response.complete||declared!==undefined&&Number(declared)!==bytes)fail('response_incomplete');
   return {status:response.statusCode,type,text:Buffer.concat(parts).toString('utf8'),retryAfter:response.headers['retry-after']??null};
  }finally{response.destroy();}
 };
}
