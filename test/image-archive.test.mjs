import test from 'node:test';
import assert from 'node:assert/strict';
import {createImageArchive,imageFromZip,sha256} from '../src/infrastructure/image-archive.mjs';
import {ociPorts} from '../runtime/oci-ports.mjs';
import {createHmac} from 'node:crypto';
import {canonical} from '../src/shared/index.mjs';

function zip(content,name='image.tar'){
 const n=Buffer.from(name),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
 local.writeUInt32LE(0x04034b50);local.writeUInt32LE(content.length,18);local.writeUInt32LE(content.length,22);local.writeUInt16LE(n.length,26);
 central.writeUInt32LE(0x02014b50);central.writeUInt32LE(content.length,20);central.writeUInt32LE(content.length,24);central.writeUInt16LE(n.length,28);
 end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+n.length,12);end.writeUInt32LE(local.length+n.length+content.length,16);
 return Buffer.concat([local,n,content,central,n,end]);
}
const raw=Buffer.from('original immutable image'),archive=zip(raw),receipt={archiveHash:'sha256:'+sha256(raw),archiveBytes:raw.length,artifact:{digest:'sha256:'+sha256(archive)}};
test('both archive layers are bound to the receipt and ZIP paths are never extracted',()=>{
 assert.deepEqual(imageFromZip(archive,receipt),raw);
 assert.throws(()=>imageFromZip(archive,{...receipt,archiveHash:'sha256:'+'a'.repeat(64)}),/oci_image_archive_invalid/);
 const other=zip(raw,'../image.tar');assert.throws(()=>imageFromZip(other,{...receipt,artifact:{digest:'sha256:'+sha256(other)}}),/oci_image_archive_invalid/);
 const multiple=Buffer.from(archive);multiple.writeUInt16LE(2,multiple.length-12);assert.throws(()=>imageFromZip(multiple,{...receipt,artifact:{digest:'sha256:'+sha256(multiple)}}),/oci_image_archive_invalid/);
});
test('lost storage acknowledgement reuses the exact verified object without another download',async()=>{
 let saved,downloads=0,putCalls=0;const scopes=[];
 const objects={read:async(scope,hash)=>{scopes.push(scope);return saved?.scope===scope?{state:'verified',length:saved.bytes.length,sha256:hash}:{state:'not_found'};},put:async(scope,bytes)=>{putCalls++;saved={scope,bytes};throw Error('lost acknowledgement');},download:async(scope,hash,options)=>({scope,hash,...options})};
 const images=createImageArchive({objects}),download=async()=>{downloads++;return archive;};
 await assert.rejects(images.preserve('project-a',receipt,download),/lost acknowledgement/);
 const storage=await images.preserve('project-a',receipt,download);assert.equal(storage.state,'verified');assert.equal(downloads,1);assert.equal(putCalls,1);
 const link=await images.download('project-a',{...receipt,storage});assert.equal(link.expiresIn,60);assert.equal(link.scope,scopes[0]);assert.equal(link.hash,receipt.archiveHash.slice(7));
 await assert.rejects(images.preserve('project-b',receipt,download),/lost acknowledgement/);assert.notEqual(saved.scope,scopes[0]);
});
test('archive broker URL must carry a valid original receipt proof and credentials never follow it',async()=>{
 const secret='test-secret',work={id:'original'},result={buildId:'original',state:'compiled',receipt,url:'https://example.blob.core.windows.net/image.zip'};
 let invalid=true,downloads=0;
 const request=async(url,options)=>{
  if(String(url).includes('/api/oci-builds'))return Response.json({result:{...result,observationProof:invalid?'0'.repeat(64):createHmac('sha256',secret).update(canonical({work,result})).digest('hex')}});
  downloads++;assert.equal(options.headers,undefined);assert.equal(options.redirect,'error');return new Response(archive);
 };
 const {ports}=ociPorts({env:{CRON_SECRET:secret},request});
 await assert.rejects(ports.download(work,receipt),/oci_image_download_unverified/);assert.equal(downloads,0);
 invalid=false;assert.deepEqual(await ports.download(work,receipt),archive);assert.equal(downloads,1);
 await assert.rejects(ports.download(work,{...receipt,archiveBytes:1}),/oci_image_download_unverified/);
});
