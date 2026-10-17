import {createHash} from 'node:crypto';
import {requireThat} from '../src/shared/index.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const code=(name,details)=>Object.assign(Error(name),{code:name,...details});

// The controller owns this adapter and authorizes the project before calling it.
// It exposes no bucket listing, delete, copy, public ACL or arbitrary object key.
export async function createR2Objects({accountId,bucket,accessKeyId,secretAccessKey,maxBytes=67108864,timeoutMs=30000,sdk,transport}){
 requireThat(/^[a-f0-9]{32}$/.test(accountId)&&/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket),'r2_target_invalid');
 requireThat(Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=268435456,'r2_size_limit_invalid');
 requireThat(Number.isSafeInteger(timeoutMs)&&timeoutMs>=1000&&timeoutMs<=30000,'r2_timeout_invalid');
 const S=sdk??await import('@aws-sdk/client-s3');
 const client=transport??new S.S3Client({region:'auto',endpoint:`https://${accountId}.r2.cloudflarestorage.com`,forcePathStyle:true,
  credentials:{accessKeyId,secretAccessKey},maxAttempts:1,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
 const key=(projectId,sha256)=>{
  requireThat(typeof projectId==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(projectId)&&/^[a-f0-9]{64}$/.test(sha256),'r2_object_reference_invalid');
  return `projects/${projectId}/sha256/${sha256}`;
 };
 const send=command=>client.send(command,{abortSignal:AbortSignal.timeout(timeoutMs)});
 async function read(projectId,sha256){
  const Key=key(projectId,sha256);let r;const signal=AbortSignal.timeout(timeoutMs);
  try{r=await client.send(new S.GetObjectCommand({Bucket:bucket,Key}),{abortSignal:signal});}
  catch(e){if(e?.$metadata?.httpStatusCode===404||e?.name==='NoSuchKey')return {state:'not_found',key:Key};throw code('r2_read_unavailable',{key:Key});}
  const parts=[];let length=0;
  const abort=()=>r.Body?.destroy?.(code('r2_read_unavailable',{key:Key}));
  signal.addEventListener('abort',abort,{once:true});
  try{
   signal.throwIfAborted();requireThat(!r.ContentLength||r.ContentLength<=maxBytes,'r2_object_too_large');
   for await(const part of r.Body){signal.throwIfAborted();length+=part.length;requireThat(length<=maxBytes,'r2_object_too_large');parts.push(part);}
   signal.throwIfAborted();
  }catch(e){if(e?.code==='r2_object_too_large')throw e;throw code('r2_read_unavailable',{key:Key});}
  finally{signal.removeEventListener('abort',abort);r.Body?.destroy?.();}
  const bytes=Buffer.concat(parts);requireThat(hash(bytes)===sha256,'r2_object_integrity_failed');
  return {state:'verified',key:Key,sha256,bytes,length};
 }
 return {
  read,
  async download(projectId,sha256,{filename,contentType,expiresIn=60}={}){
   requireThat(expiresIn===60&&(filename==='image.tar'&&contentType==='application/x-tar'||filename===sha256&&contentType==='application/octet-stream'),'r2_download_invalid');
   const Key=key(projectId,sha256);
   const {getSignedUrl}=await import('@aws-sdk/s3-request-presigner');
   const url=await getSignedUrl(client,new S.GetObjectCommand({Bucket:bucket,Key,ResponseContentType:contentType,ResponseContentDisposition:`attachment; filename="${filename}"`}),{expiresIn});
   return {url,expiresAt:Date.now()+expiresIn*1000,method:'GET'};
  },
  async put(projectId,bytes){
   requireThat(bytes instanceof Uint8Array&&bytes.length>0&&bytes.length<=maxBytes,'r2_object_too_large');
   const sha256=hash(bytes),Key=key(projectId,sha256);
   try{await send(new S.PutObjectCommand({Bucket:bucket,Key,Body:bytes,ContentLength:bytes.length,ContentType:'application/octet-stream',CacheControl:'private, no-store',Metadata:{sha256},IfNoneMatch:'*'}));}
   catch(e){
    if(e?.$metadata?.httpStatusCode!==412&&e?.name!=='PreconditionFailed')throw code('r2_write_outcome_unknown',{projectId,key:Key,sha256});
    // Another writer or an earlier uncertain attempt already used this exact key.
    // Verify bytes; metadata alone is not an integrity proof.
   }
   const observed=await read(projectId,sha256);requireThat(observed.state==='verified','r2_write_not_visible');
   return {state:'verified',key:Key,sha256,bytes:observed.length};
  }
 };
}
