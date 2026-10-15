import {createHash} from 'node:crypto';

// Only a matching rejected session is evicted. Concurrent callers share one
// login; late rejections cannot evict its replacement. No operation is retried.
export function createSessionCache({issue,now=Date.now}){
 let current=null,pending=null;
 const digest=token=>createHash('sha256').update(token).digest('hex');
 async function session({rejectedSession}={}){
  if(rejectedSession!==undefined&&!/^[a-f0-9]{64}$/.test(rejectedSession))throw Error('invalid_session_recovery');
  if(current&&rejectedSession===digest(current.token))current=null;
  if(current&&current.expiresAt>now()+30000)return {...current};
  if(!pending){
   pending=(async()=>{
    const value=await issue();
    if(!/^cln_[A-Za-z0-9_-]{43}$/.test(value?.token??'')||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now()+30000)throw Error('network_session_invalid');
    current={token:value.token,expiresAt:value.expiresAt};return current;
   })();
  }
  const attempt=pending;
  try{return {...await attempt};}finally{if(pending===attempt)pending=null;}
 }
 function reject(token){if(current?.token===token)current=null;}
 return {session,reject};
}
