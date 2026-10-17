import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {managedSchemaReady} from './database-schema.js';
import {productionLabDatabase} from './lab-db.js';
import {runtimeHostPulse} from './runtime-host.js';
import {configuration} from './store.js';
import {wakeDecision} from './social.js';
import {cycle} from './cycle.js';

const primary='https://claus-agent.vercel.app/health';
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
export async function primaryHealthy(){
 try{const r=await fetch(primary,{redirect:'error',signal:AbortSignal.timeout(12000)});return r.status===200&&(await r.json()).service==='claus-agent';}catch{return false;}
}
export async function standbyProbe(){
 await managedSchemaReady();const db=productionLabDatabase(),config=await configuration();
 const boundary=(await db.query("SELECT current_user AS role,has_table_privilege(current_user,'public.claus_native_hosts','INSERT,UPDATE,DELETE') AS host_write")).rows[0];
 if(boundary?.role!=='claus_native_runtime'||boundary.host_write)throw Error('standby_boundary_invalid');
 const state=(await db.query('SELECT generation,memory,agenda,continuation,status,next_at FROM claus_state WHERE id=1')).rows[0];
 const control=(await db.query("SELECT enabled,mode,primary_deployment,primary_seen_at FROM claus_native_hosts WHERE id")).rows[0];
 const work=(await db.query("SELECT id,revision,status FROM claus_network_work ORDER BY id")).rows;
 const pending=(await db.query("SELECT id,status,input_hash FROM claus_actions WHERE status NOT IN ('completed','failed') ORDER BY id")).rows;
 if(!state||!control)throw Error('standby_state_unavailable');
 return {status:'ready',configurationRevision:config.revision,generation:state.generation,workItems:work.length,unresolvedActions:pending.length,
  originalStateHash:createHash('sha256').update(JSON.stringify({state,work,pending})).digest('hex'),hostControl:control,readOnly:true,coverage:'native-social-and-network-worker'};
}
export async function runStandby(){
 await managedSchemaReady();
 if(await primaryHealthy())return {status:'primary_healthy',claimed:false};
 await pause(15000);if(await primaryHealthy())return {status:'primary_recovered',claimed:false};
 const db=productionLabDatabase(),executor=process.env.CLAUS_RUNTIME_EXECUTOR,deployment=process.env.VERCEL_DEPLOYMENT_ID;
 if(!executor||!deployment)throw Error('standby_identity_missing');
 const claim=(await db.query('SELECT public.claus_native_host_claim($1,$2,true) AS result',[executor,deployment])).rows[0]?.result;
 if(claim?.status!=='claimed')return {...claim,claimed:false};
 const generation=Number(claim.generation),epoch=Number(claim.epoch),deadline=Date.parse(claim.deadline);
 process.env.CLAUS_RUNTIME_HOST='standby';process.env.CLAUS_RUNTIME_EPOCH=String(epoch);
 let permitted=true,pulsing=false,stopping=false,turns=0,returned=false;
 const stop=()=>{stopping=true;};process.once('SIGTERM',stop);process.once('SIGINT',stop);
 const timer=setInterval(async()=>{if(pulsing)return;pulsing=true;try{permitted=await runtimeHostPulse(generation);}catch{permitted=false;}finally{pulsing=false;}},25000);timer.unref();
 try{
  while(!stopping&&permitted&&Date.now()<deadline-14*60_000){
   if(await primaryHealthy()){
    returned=(await db.query('SELECT public.claus_native_host_return($1,$2,$3) AS returned',[executor,generation,epoch])).rows[0]?.returned===true;
    if(returned)break;
   }
   const wake=await wakeDecision(generation);if(!wake.nextAt)break;
   if(wake.run){await cycle(generation);turns++;}
   else await pause(Math.max(1000,Math.min(30000,Date.parse(wake.nextAt)-Date.now())));
  }
  if(!returned&&await primaryHealthy())returned=(await db.query('SELECT public.claus_native_host_return($1,$2,$3) AS returned',[executor,generation,epoch])).rows[0]?.returned===true;
  return {status:returned?'return_requested':'lease_will_expire',claimed:true,generation,epoch,turns};
 }finally{clearInterval(timer);process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const mode=process.argv[2];if(!['probe','run'].includes(mode))throw Error('invalid_standby_mode');
 (mode==='probe'?standbyProbe():runStandby()).then(v=>console.log(JSON.stringify(v))).catch(()=>{console.error(JSON.stringify({status:'standby_unavailable'}));process.exitCode=1;});
}
