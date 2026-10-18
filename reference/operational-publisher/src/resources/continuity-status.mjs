export const continuityStatusInputs={continuity_status:[]};
export async function continuityStatus({env=process.env,request=fetch}={}){
 const origin=new URL(env.CONTINUITY_URL);
 if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.username||origin.password||!env.CONTINUITY_SECRET)throw Error('resource_continuity_unconfigured');
 const r=await request(origin.origin+'/v1/status',{headers:{authorization:'Bearer '+env.CONTINUITY_SECRET},redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error('resource_continuity_unavailable');
 const s=await r.json();
 if(!s.control||!Array.isArray(s.replication))throw Error('resource_continuity_invalid');
 return {observedAt:new Date().toISOString(),control:s.control,databaseProvider:s.databaseProvider,independentModel:s.independentModel,
  replication:s.replication.map(x=>({name:x.name,state:x.body?.state??'unavailable',sampledAt:x.sampled_at,fresh:x.fresh===true,appliedCheckpoint:x.body?.appliedCheckpoint??null,error:x.last_error,schemaFingerprint:x.body?.schemaFingerprint,targetFingerprint:x.body?.targetFingerprint,relations:x.body?.relations,progress:x.body?.progress})),
  effects:s.effects,inference:s.inference,grants:s.grants,checkpoints:s.checkpoints,
  meaning:'Authenticated independent controller observation. Current replica metadata is not an activated takeover. Writer enforcement, complete effect coverage, ready replacement services and controlled routing are all required for coordinated failover. Keep uncertain original actions and their funding. This read does not execute a model, renew a lease or change authority.'};
}
