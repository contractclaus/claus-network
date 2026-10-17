import {authorized} from './policy.js';

const origin='https://claus-agent.vercel.app';
export function guardianDue(state,now=Date.now()){
 if(!state?.enabled||!['working','waiting','waiting_for_effect','retrying'].includes(state.status))return false;
 if(state.lease_until&&(!Number.isFinite(Date.parse(state.lease_until))||Date.parse(state.lease_until)>now))return false;
 const overdue=now-300000;
 return Number.isFinite(Date.parse(state.next_at))&&Date.parse(state.next_at)<overdue || state.status==='waiting'&&state.mentions&&Date.parse(state.updated_at)<overdue&&Date.parse(state.next_poll_at)<overdue&&(!state.poll_lease_until||Date.parse(state.poll_lease_until)<now);
}

export async function guardRuntime({snapshot,fetcher=fetch,secret,now=()=>Date.now()}){
 const state=snapshot?await snapshot():null;
 if(state&&!state.enabled)return {state:'paused',recoveryAttempted:false};
 if(state&&!guardianDue(state,now()))return {state:'healthy_or_waiting',generation:state.generation,recoveryAttempted:false};
 if(!secret)return {state:'recovery_not_configured',recoveryAttempted:false};
 // Only the existing fixed recovery route can resume work. It performs its own
 // current-policy, generation and lease CAS; no provider/model call is replayed here.
 try{
  const response=await fetcher(origin+'/api/recover',{method:'GET',headers:{authorization:'Bearer '+secret},redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok){await response.body?.cancel();return {state:'recovery_unavailable',httpStatus:response.status,recoveryAttempted:true};}
  const result=await response.json();
  return {state:typeof result.status==='string'?result.status:'recovery_response_invalid',generation:state?.generation??null,recoveryAttempted:true};
 }catch{return {state:'recovery_unavailable',recoveryAttempted:true};}
}

export function installRuntimeGuardian(app,{role=()=>process.env.SERVICE_ROLE,cronSecret=()=>process.env.CRON_SECRET,recoverySecret=()=>process.env.NATIVE_RECOVERY_SECRET,snapshot}={}){
 app.get('/api/runtime/guardian',async c=>{
  if(role()!=='operator')return c.json({error:'guardian_disabled'},403);
  if(!authorized(c.req.header('authorization'),cronSecret()))return c.json({error:'unauthorized'},401);
  c.header('Cache-Control','no-store');
  try{return c.json(await guardRuntime({snapshot,secret:recoverySecret()}));}
  catch{return c.json({state:'observation_unavailable',recoveryAttempted:false},503);}
 });
}
