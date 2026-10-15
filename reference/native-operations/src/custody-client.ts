// Fixed purpose API. A caller never supplies a host, wallet recipient or raw signature.
const origin='https://claus-inference.vercel.app';
export function custodyConfigured(){return !!process.env.CLAUS_JOBS_CUSTODY_SECRET;}
export function createCustodyClient({request=fetch,secret=()=>process.env.CLAUS_JOBS_CUSTODY_SECRET}:any={}){
 async function invoke(path:'wallet'|'session',body:any){
  const key=secret();if(!key)throw Error('work_wallet_custody_unavailable');
  const r=await request(origin+'/api/jobs/'+path,{method:'POST',redirect:'error',signal:AbortSignal.timeout(55000),headers:{authorization:'Bearer '+key,'content-type':'application/json',accept:'application/json'},body:JSON.stringify(body)});
  const reader=r.body?.getReader();if(!reader)throw Error('work_wallet_custody_unavailable');const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.byteLength;if(size>400000){await reader.cancel();throw Error('work_wallet_custody_response_too_large');}chunks.push(p.value);}}finally{reader.releaseLock();}
  const result=JSON.parse(Buffer.concat(chunks).toString());if(!r.ok)throw Error('work_wallet_custody_unavailable');return result;
 }
 async function session(){const r=await invoke('session',{});if(!/^cln_[A-Za-z0-9_-]{43}$/.test(r.token??'')||!Number.isSafeInteger(r.expiresAt)||r.expiresAt<=Date.now())throw Error('network_session_invalid');return r;}
 async function tool(args:any){try{return await invoke('wallet',args);}catch{return {error:'work_wallet_custody_unavailable',outcome:'unknown',next:'Read status for the original action. A transport failure does not prove that no transaction was sent.'};}}
 return {session,tool};
}
export const custodyClient=createCustodyClient();
