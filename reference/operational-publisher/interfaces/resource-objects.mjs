import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
const target=raw=>{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.port||!u.hostname.endsWith('.r2.cloudflarestorage.com'))throw Error('storage_target_invalid');return u;};
// call(operation,input,requestId) must authenticate using a server-side credential.
// A delegated worker receives a prepared objectId and only its bucket's grant.
export async function prepareLocalObject(call,{resourceId,path,name,requestId}){
 const stat=await fsp.stat(path);if(!stat.isFile())throw Error('storage_file_required');const hash=createHash('sha256');for await(const chunk of fs.createReadStream(path))hash.update(chunk);
 return call('object_prepare',{resourceId,name:name??path.split('/').at(-1),bytes:stat.size,sha256:hash.digest('hex')},requestId);
}
export async function uploadLocalObject(call,{resourceId,objectId,path,requestId},{request=fetch,signal}={}){
 let {object}=await call('object_get',{resourceId,objectId},requestId+':get');if(object.state==='ready')return object;
 const stat=await fsp.stat(path);if(stat.size!==object.bytes)throw Error('storage_file_changed');
 if(object.state==='uploading'){
  const parts=new Map();let marker=0;do{const page=await call('object_parts',{resourceId,objectId,afterPart:marker},requestId+':parts:'+marker);for(const part of page.items??[])parts.set(part.number,part);marker=page.next;}while(marker!==null&&marker!==undefined);
  for(let n=1;n<=object.partCount;n++){
   const expected=Math.min(object.partBytes,object.bytes-(n-1)*object.partBytes);if(parts.get(n)?.bytes===expected)continue;
   const item=await call('object_upload',{resourceId,objectId,partNumber:n},requestId+':part:'+n);
   if(item.bytes!==expected||item.offset!==(n-1)*object.partBytes||item.upload.headers['content-length']!==String(expected))throw Error('storage_part_mismatch');
   const body=fs.createReadStream(path,{start:item.offset,end:item.offset+item.bytes-1});
   try{const response=await request(target(item.upload.url),{method:'PUT',headers:item.upload.headers,body,duplex:'half',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(300000)]):AbortSignal.timeout(300000)});await response.body?.cancel();if(!response.ok)throw Error('storage_upload_'+response.status);}
   catch(e){throw Object.assign(e,{resourceId,objectId,requestId,next:'Resume this original object; object_parts reconciles the exact part before another upload.'});}
   finally{body.destroy();}
  }
 }
 for(;;){const result=await call('object_commit',{resourceId,objectId},requestId+':commit');if(result.error)throw Error(result.error);if(result.object?.state==='ready')return result.object;if(!result.pending)throw Object.assign(Error('storage_commit_unknown'),{resourceId,objectId,requestId});signal?.throwIfAborted();}
}
export async function downloadLocalObject(call,{resourceId,objectId,path,requestId},{request=fetch,signal}={}){
 const {object,download}=await call('object_download',{resourceId,objectId},requestId+':download');if(object.state!=='ready')throw Error('storage_not_ready');
 const partial=path+'.partial-'+object.id;let size=0;try{size=(await fsp.stat(partial)).size;}catch(e){if(e.code!=='ENOENT')throw e;}if(size>object.bytes)throw Error('storage_partial_too_large');
 if(size<object.bytes){
  const response=await request(target(download.url),{headers:{...download.headers,...(size?{range:'bytes='+size+'-'}:{})},redirect:'error',signal});
  if(response.status!==(size?206:200))throw Error('storage_download_'+response.status);
  let received=size;const limit=async function*(source){for await(const chunk of source){received+=chunk.length;if(received>object.bytes)throw Error('storage_download_size');yield chunk;}};
  await pipeline(Readable.fromWeb(response.body),limit,fs.createWriteStream(partial,{flags:size?'a':'wx'}));
 }
 const hash=createHash('sha256');for await(const chunk of fs.createReadStream(partial))hash.update(chunk);if((await fsp.stat(partial)).size!==object.bytes||hash.digest('hex')!==object.sha256)throw Error('storage_download_integrity');
 // Preserve any existing destination; the caller chooses when to replace it.
 await fsp.link(partial,path);await fsp.unlink(partial);return {path,object};
}
