import {check,providerRequest} from './providers.mjs';
import {createHash} from 'node:crypto';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const digest=v=>'sha256:'+createHash('sha256').update(canonical(v)).digest('hex');
// Read only the fixed network origin. Project input cannot supply a verifier URL.
export async function runtimeReleaseApproved(work,{request=fetch}={}){
 const id=work.manifest?.releaseHash;check(/^sha256:[a-f0-9]{64}$/.test(id??''),'release_invalid');
 const r=await request('https://claus-network-api.vercel.app/v1/public/infrastructure/releases/'+encodeURIComponent(id),{method:'GET',redirect:'error',headers:{accept:'application/json'},signal:AbortSignal.timeout(12000)});
 check(r.ok,'release_unavailable');const reader=r.body?.getReader();check(reader,'release_unavailable');let size=0;const chunks=[];
 try{for(;;){const x=await reader.read();if(x.done)break;size+=x.value.length;check(size<=4096,'release_response_invalid');chunks.push(x.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const v=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 // Shared API returns {result} for authenticated calls and public calls alike.
 const result=v.result??v;
 check(result.releaseId===id&&typeof result.approved==='boolean','release_response_invalid');
 if(!result.approved)return false;
 return (!work.manifest.secretBindings?.length||result.ownerSecretBindings===true)&&result.projectId===work.projectId&&result.image===work.manifest.image&&result.manifestHash===digest(work.manifest)&&/^sha256:[a-f0-9]{64}$/.test(result.reviewHash??'')&&/^sha256:[a-f0-9]{64}$/.test(result.decisionHash??'');
}
