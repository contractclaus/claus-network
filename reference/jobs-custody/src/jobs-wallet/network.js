import {privateKeyToAccount} from 'viem/accounts';
import {validateLogin} from './login.js';
import {validate} from './validation.js';
import {paymentRoutes} from './work-wallet-contract.js';
import {readRoutes} from './read-routes.js';
import {createSessionCache} from './session-cache.js';
const origin='https://claus-network-api.vercel.app';
export function createNetworkAccess({request=fetch,key=()=>process.env.JOBS_WALLET_PRIVATE_KEY,now=Date.now,extraRoutes={},maximumResponseBytes=3200000}={}){
 const cache=createSessionCache({issue:newSession,now});
 async function json(path,method='GET',body,token){
  const r=await request(origin+path,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{accept:'application/json',...(body?{'content-type':'application/json'}:{}),...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const reader=r.body?.getReader();if(!reader)throw Error('network_response_empty');let size=0;const chunks=[];
  try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.byteLength;if(size>maximumResponseBytes){await reader.cancel();throw Error('network_response_too_large');}chunks.push(p.value);}}finally{reader.releaseLock();}
  let result;try{result=JSON.parse(Buffer.concat(chunks).toString());}catch{throw Error('network_response_invalid');}
  if(!r.ok)throw Object.assign(Error('network_request_failed'),{status:r.status,code:typeof result.error==='string'?result.error.slice(0,100):'request_failed'});
  return result;
 }
 async function newSession(){
  const secret=key();if(!/^0x[0-9a-f]{64}$/i.test(secret??''))throw Error('network_identity_unavailable');
  const account=privateKeyToAccount(secret);if(account.address.toLowerCase()!=='0x59edf6152080e847e5ea15f9ae6a77c1f03c44f5')throw Error('network_identity_mismatch');
  const challenge=await json('/v1/auth/challenge','POST',{address:account.address});validateLogin(challenge,account.address,now());
  const signature=await account.signMessage({message:challenge.message});
  const result=await json('/v1/auth/session','POST',{challengeId:challenge.id,signature});
  if(!/^cln_[A-Za-z0-9_-]{43}$/.test(result.token??'')||!Number.isSafeInteger(result.credential?.expiresAt))throw Error('network_session_invalid');
  return {token:result.token,expiresAt:result.credential.expiresAt};
 }
 const session=cache.session;
 async function call(name,args={}){
  const route=paymentRoutes[name]??readRoutes[name]??extraRoutes[name];if(!route)throw Error('network_operation_unavailable');validate(route.inputSchema,args);
  const input={...args},path=route.path.replace(/\{(\w+)\}/g,(_,k)=>{const v=input[k];delete input[k];return encodeURIComponent(String(v));});
  const query=route.method==='GET'?new URLSearchParams(Object.entries(input).map(([k,v])=>[k,String(v)])).toString():'';
  const bearer=route.public?undefined:(await session()).token;
  try{return await json(path+(query?'?'+query:''),route.method,route.method==='GET'?undefined:input,bearer);}catch(e){if(e.status===401&&bearer)cache.reject(bearer);throw e;}
 }
 return {call,session};
}
