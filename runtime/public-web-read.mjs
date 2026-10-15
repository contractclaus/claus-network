import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {publicIPv4} from './webhook-delivery.mjs';
import {requireThat} from '../src/shared/index.mjs';
// Pin each resolved hop. No cookies, caller headers, credentials or redirects
// reach a private host, even if DNS changes between validation and connection.
export async function publicWebRead(input,{resolve=lookup,send=request,now=()=>Date.now()}={}){
 const started=now();let current=new URL(input),redirects=0;
 for(;;){
  requireThat(current.protocol==='https:'&&!current.username&&!current.password&&(!current.port||current.port==='443')&&current.href.length<=2048,'web_destination_denied');
  requireThat(!current.hostname.includes(':')&&!current.hostname.endsWith('.local')&&current.hostname!=='localhost','web_destination_denied');
  let timer;const ips=await Promise.race([resolve(current.hostname,{all:true,family:4}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('web_timeout'),{code:'web_timeout'})),4000);})]).finally(()=>clearTimeout(timer));
  requireThat(ips.length&&ips.every(x=>publicIPv4(x.address)),'web_destination_denied');
  const response=await new Promise((accept,reject)=>{
   const remaining=12000-(now()-started);if(remaining<=0)return reject(Object.assign(Error('web_timeout'),{code:'web_timeout'}));
   const r=send(current,{method:'GET',agent:false,lookup:(_host,opts,cb)=>opts.all?cb(null,[ips[0]]):cb(null,ips[0].address,4),headers:{accept:'text/plain, text/html, application/json;q=0.9','user-agent':'ClausNetworkReader/1.0','accept-encoding':'identity'}},res=>{
    const status=res.statusCode??0,location=res.headers.location,contentType=String(res.headers['content-type']??'').split(';')[0].toLowerCase();
    if(status>=300&&status<400&&location){res.destroy();accept({status,location});return;}
    if(!/^(text\/(plain|html|markdown|csv)|application\/(json|[^;]+\+json))$/.test(contentType)){res.destroy();reject(Object.assign(Error('web_content_type_denied'),{code:'web_content_type_denied'}));return;}
    const chunks=[];let bytes=0;res.on('data',chunk=>{const buffer=Buffer.from(chunk),left=12000-bytes;chunks.push(buffer.subarray(0,Math.max(0,left)));bytes+=buffer.length;if(bytes>12000){res.destroy();accept({status,contentType,text:Buffer.concat(chunks).toString('utf8').slice(0,4000),truncated:true});}});res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');accept({status,contentType,text:text.slice(0,4000),truncated:text.length>4000});});res.on('error',reject);
   });const deadline=setTimeout(()=>r.destroy(Object.assign(Error('web_timeout'),{code:'web_timeout'})),Math.min(8000,remaining));r.on('close',()=>clearTimeout(deadline));r.on('error',reject);r.end();
  });
  if(response.location){requireThat(redirects++<3,'web_redirect_limit');current=new URL(response.location,current);continue;}
  return{url:current.href,observedAt:now(),...response,instructionAuthority:false};
 }
}
