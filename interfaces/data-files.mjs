// Node 24 and modern Fetch clients. Provider/account keys never enter this helper.
const hash=async bytes=>'sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
const target=raw=>{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.port||!u.hostname.endsWith('.r2.cloudflarestorage.com'))throw Error('invalid_data_transfer_target');return u;};
export async function uploadDataFile(client,{projectId,name,bytes,idempotencyKey},{fetch:request=globalThis.fetch,signal}={}){
 if(!(bytes instanceof Uint8Array))throw Error('data_bytes_required');
 const sha256=await hash(bytes),prepared=await client.call('data_file_prepare',{projectId,name,sha256,bytes:bytes.length,idempotencyKey},{signal});
 if(prepared.file.sha256!==sha256||prepared.file.bytes!==bytes.length)throw Error('data_upload_mismatch');
 if(prepared.file.state==='ready')return prepared.file;
 const {upload}=prepared;if(!upload||upload.expiresAt<=Date.now())throw Error('data_upload_expired');
 const headers=upload.headers;if(headers['content-length']!==String(bytes.length)||headers['content-type']!=='application/octet-stream'||headers['if-none-match']!=='*'||Object.keys(headers).some(k=>!['content-length','content-type','if-none-match','cache-control'].includes(k)))throw Error('invalid_data_upload_headers');
 let failure;
 try{const r=await request(target(upload.url),{method:'PUT',body:bytes,headers,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});await r.body?.cancel();if(!r.ok&&r.status!==412)failure=Error('data_upload_http_'+r.status);}catch(e){failure=e;}
 // Reconcile this exact uploaded object; never automatically send its bytes again.
 try{return await client.call('data_file_commit',{projectId,fileId:prepared.file.id},{signal});}
 catch(e){throw Object.assign(failure??e,{fileId:prepared.file.id,outcome:'upload_unconfirmed',next:'Read or commit this same fileId before starting another upload.'});}
}
export async function downloadDataFile(client,{projectId,fileId},{fetch:request=globalThis.fetch,signal}={}){
 const {file,download}=await client.call('data_file_download',{projectId,fileId},{signal});
 if(!download||download.expiresAt<=Date.now())throw Error('data_download_expired');
 const r=await request(target(download.url),{method:'GET',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});
 if(!r.ok){await r.body?.cancel();throw Error('data_download_http_'+r.status);}
 const reader=r.body?.getReader();if(!reader)throw Error('data_download_empty');let size=0;const chunks=[];
 try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>file.bytes)throw Error('data_download_size_mismatch');chunks.push(p.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 if(size!==file.bytes)throw Error('data_download_size_mismatch');const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}if(await hash(bytes)!==file.sha256)throw Error('data_download_hash_mismatch');
 return {file,bytes};
}
