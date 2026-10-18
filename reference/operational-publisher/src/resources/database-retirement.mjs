import {createHash} from 'node:crypto';
import {S3Client,GetObjectCommand,HeadObjectCommand} from '@aws-sdk/client-s3';
import {verifyRetirementProof} from './database-retirement-proof.mjs';
const bucket='claus-owned-52ea277fe0f81ddd9a952cf9';
const sourceId=connection=>{const u=new URL(connection);return createHash('sha256').update(u.hostname.replace('-pooler.','.')+u.pathname).digest('hex');};
export function databaseRetirement({query,environment=process.env,now=Date.now,storage}){
 const execute=async(name,args)=>{
  try{return (await query('SELECT claus_resource_admin.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') AS value',args)).rows[0].value;}
  catch(e){if(/^resource_retirement_[a-z_]+$/.test(e.message??''))throw e;throw Error('resource_retirement_database_operation_unavailable');}
 };
 async function proof(state){
  if(!environment.RECOVERY_BACKUP_SECRET||!environment.RESOURCE_DATABASE_URL)throw Error('resource_retirement_backup_not_connected');
  const s3=storage??new S3Client({region:'auto',endpoint:'https://'+environment.RESOURCE_R2_ACCOUNT_ID+'.r2.cloudflarestorage.com',credentials:{accessKeyId:environment.RESOURCE_R2_ACCESS_KEY,secretAccessKey:environment.RESOURCE_R2_SECRET_KEY},maxAttempts:1,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
  const send=command=>s3.send(command,{abortSignal:AbortSignal.timeout(20000)});
  try{
   let object;
   try{object=await send(new GetObjectCommand({Bucket:bucket,Key:'objects/recurring-v5/retirements/'+state.planId+'.json'}));}
   catch(e){if(e?.$metadata?.httpStatusCode===404||e?.name==='NoSuchKey')return null;throw Error('resource_retirement_backup_lookup_unavailable');}
   if(!Number.isSafeInteger(object.ContentLength)||object.ContentLength>32000)throw Error('resource_retirement_export_proof_invalid');
   const chunks=[];let size=0;for await(const chunk of object.Body){size+=chunk.length;if(size>32000)throw Error('resource_retirement_export_proof_invalid');chunks.push(Buffer.from(chunk));}
   let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('resource_retirement_export_proof_invalid');}
   const p=verifyRetirementProof(value,{...state,bucket,sourceId:sourceId(environment.RESOURCE_DATABASE_URL)},environment.RECOVERY_BACKUP_SECRET,now());
   for(const f of [p.dump,p.checkpoint]){
    let head;try{head=await send(new HeadObjectCommand({Bucket:bucket,Key:f.key,IfMatch:f.etag}));}catch{throw Error('resource_retirement_backup_object_changed');}
    if(head.ContentLength!==f.bytes||head.ETag!==f.etag||head.Metadata?.sha256!==f.sha256)throw Error('resource_retirement_backup_object_changed');
   }
   return p;
  }finally{if(!storage)s3.destroy();}
 }
 return {
  state:(id,plan)=>execute('retirement_status',[id,plan]),
  async apply(id,plan,disposition){
   // Each query commits separately: NOLOGIN must be visible before sessions drain.
   let state=await execute('retirement_start',[id,plan]);
   if(['retained','removed'].includes(state.phase))return state;
   state=await execute('retirement_drain',[id,plan]);
   if(state.phase!=='frozen'||state.reason)return state;
   let verified=null;
   if(disposition==='database-export'){
    verified=await proof(state);
    if(!verified)return {...state,reason:'awaiting_independent_database_snapshot',next:'Keep this original plan. The six-hour backup schedule will export the frozen application database and retain a signed original proof; repeat retirement_apply afterward.'};
   }
   return execute('retirement_finish',[id,plan,disposition,verified===null?null:JSON.stringify(verified)]);
  }
 };
}
