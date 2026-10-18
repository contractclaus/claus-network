import {neon} from '@neondatabase/serverless';
// The decision lives in the independent recovery database and is never cached.
// Losing contact pauses new work; it does not authorize another database writer.
export async function databasePermit(env=process.env):Promise<boolean>{
 if(env.CONTINUITY_EFFECTS_ENABLED==='true'){
  if(!env.CONTINUITY_URL||!env.CONTINUITY_SECRET||!['primary','standby'].includes(env.CONTINUITY_INSTANCE??''))throw Error('database_fence_not_configured');
  const response=await fetch(env.CONTINUITY_URL+'/v1/fence/permit',{method:'POST',headers:{authorization:'Bearer '+env.CONTINUITY_SECRET,'content-type':'application/json'},body:JSON.stringify({instance:env.CONTINUITY_INSTANCE,epoch:Number(env.CONTINUITY_WRITER_EPOCH)}),redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('database_fence_unavailable');return (await response.json()).allowed===true;
 }
 const url=env.NATIVE_DATABASE_FENCE_URL,instance=env.NATIVE_DATABASE_INSTANCE;
 if(!url||!['primary','standby'].includes(instance??''))throw Error('database_fence_not_configured');
 const rows=await neon(url).query('SELECT claus_recovery.permit($1) AS allowed',[instance],{fetchOptions:{signal:AbortSignal.timeout(10000)}});
 return rows[0]?.allowed===true;
}
export async function requireDatabasePermit(){if(!await databasePermit())throw Error('database_instance_fenced');}
