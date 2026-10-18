import {createHash,randomUUID} from 'node:crypto';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const continuityEnabled=(env=process.env)=>env.CONTINUITY_EFFECTS_ENABLED==='true';
export function continuityGate({env=process.env,request=fetch,writeBarriers,component}){
 async function call(path,input){
  const origin=new URL(env.CONTINUITY_URL);
  if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.username||origin.password)throw Error('continuity_origin_invalid');
  const response=await request(origin.origin+path,{method:'POST',headers:{authorization:'Bearer '+env.CONTINUITY_SECRET,'content-type':'application/json'},body:JSON.stringify(input),redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('continuity_'+response.status);return response.json();
 }
 return async function guard({kind,originalId,input},run){
  if(!continuityEnabled(env))return run();
  if(typeof writeBarriers!=='function'||!['primary','standby'].includes(env.CONTINUITY_INSTANCE))throw Error('continuity_incomplete_configuration');
  const epoch=Number(env.CONTINUITY_WRITER_EPOCH);if(!Number.isSafeInteger(epoch)||epoch<1)throw Error('continuity_epoch_missing');
  const permit=await call('/v1/fence/permit',{instance:env.CONTINUITY_INSTANCE,epoch});
  if(permit.allowed!==true||Number(permit.epoch)!==epoch)throw Error('continuity_instance_fenced');
  // Every execution attempt has its own durable record. The existing business
  // request ID remains in the input and continues to own provider idempotency.
  const id=component+':'+randomUUID(),record={component,kind,originalId:originalId??null,input};
  const claim=await call('/v1/effects/claim',{id,kind:component+':'+kind,input:record,inputHash:digest(record),instance:env.CONTINUITY_INSTANCE,epoch});
  if(claim.id!==id||claim.execute!==true||Number(claim.epoch)!==epoch||!claim.token)throw Error('continuity_claim_uncertain');
  let result,finished=false,barriers;
  try {
   result=await run();finished=true;
   barriers=await writeBarriers(id,permit.epoch);
   if(!Array.isArray(barriers)||barriers.length===0)throw Error('continuity_barriers_missing');
   const confirmed=await call('/v1/barriers/wait',{id,databases:barriers});
   if(confirmed.id!==id||confirmed.confirmed!==true)throw Error('continuity_replication_pending');
   const settled=await call('/v1/effects/settle',{id,token:claim.token,state:'completed',result:{value:result,barriers,epoch:permit.epoch}});
   if(settled.id!==id||settled.state!=='completed')throw Error('continuity_settlement_uncertain');
   return result;
  } catch(error){
   try{await call('/v1/effects/settle',{id,token:claim.token,state:'uncertain',result:{executionFinished:finished,...(finished?{value:result}:{}),barriers:barriers??null,epoch:permit.epoch,error:{name:error?.name??'Error',code:/^[a-z0-9_]{1,100}$/i.test(error?.message??'')?error.message:'original_execution_uncertain'}}});}catch{}
   throw error;
  }
 };
}
export function postgresBarriers(databases){
 return async(id,epoch)=>{
  for(const [name,query]of Object.entries(databases))await query('INSERT INTO public.claus_continuity_barriers(id,epoch,schema_fingerprint,sequence_heads) VALUES($1,$2,public.claus_continuity_schema_signature(),(SELECT COALESCE(jsonb_agg(jsonb_build_object(\'schema\',schemaname,\'name\',sequencename,\'value\',last_value::text)),\'[]\'::jsonb) FROM pg_sequences WHERE last_value IS NOT NULL)) ON CONFLICT DO NOTHING',[id,epoch]);
  return Object.keys(databases);
 };
}
export function continuityMiddleware({gate,mutating=()=>true}){
 return async(c,next)=>{
  if(!mutating(c)||!continuityEnabled())return next();
  const reader=c.req.raw.clone().body?.getReader();let size=0;const chunks=[];
  if(reader)try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>4200000)throw Error('continuity_request_too_large');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});}
  const raw=Buffer.concat(chunks).toString('utf8');let input;try{input=raw?JSON.parse(raw):null;}catch{input={raw};}
  const originalId=c.req.header('idempotency-key')??input?.requestId??input?.id??input?.actionId??null;
  await gate({kind:c.req.method+' '+c.req.path,originalId,input},async()=>{
   await next();const bytes=Buffer.from(await c.res.clone().arrayBuffer());
   return {status:c.res.status,contentType:c.res.headers.get('content-type'),responseSha256:createHash('sha256').update(bytes).digest('hex'),...(bytes.length<=1000000?{body:bytes.toString('base64'),encoding:'base64'}:{bytes:bytes.length,responseOmitted:true})};
  });
 };
}
