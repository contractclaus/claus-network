import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {privateRegistry} from '../src/resources/private-registry.mjs';
import {readBuildReceiptZip} from '../src/resources/build-receipt.mjs';
import {crc32,deflateRawSync} from 'node:zlib';
const digest=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
test('private image verifies source and digest metadata without transferring gigabyte layers or forwarding credentials',async()=>{
 const repository='claus-private-app',source='a'.repeat(40),actionId='act_'+'b'.repeat(24),key='retained-private-package-read-key';
 const config=Buffer.from(JSON.stringify({os:'linux',architecture:'amd64',config:{Labels:{'org.opencontainers.image.source':'https://github.com/contractclaus/'+repository,'org.opencontainers.image.revision':source,'si.claus.action':actionId}}}));
 const manifest=Buffer.from(JSON.stringify({schemaVersion:2,config:{digest:digest(config)},layers:[{digest:digest('large layer'),size:5*1024**3}]}));
 let requests=0;
 const request=async(url,options)=>{
  requests++;url=String(url);
  if(url.startsWith('https://api.github.com/')){assert.equal(options.headers.authorization,'Bearer '+key);return Response.json({visibility:'private',name:repository,owner:{login:'contractclaus'}});}
  if(url.startsWith('https://ghcr.io/token?')){assert(options.headers.authorization.startsWith('Basic '));return Response.json({token:'ephemeral-pull-token'});}
  if(url.includes('/manifests/'))return new Response(manifest);
  if(url.includes('/blobs/'+digest(config)))return new Response(config);
  throw Error('Unexpected request, especially layer download: '+url);
 };
 const registry=privateRegistry({request,token:()=>key}),input={repository,source,actionId,architecture:'amd64',imageDigest:digest(manifest)};
 const result=await registry.inspect(input);assert.equal(result.compressedBytes,5*1024**3);assert.equal(requests,4);assert(!JSON.stringify(result).includes(key));
 await assert.rejects(registry.inspect({...input,source:'c'.repeat(40)}),/source_binding_changed/);
});
test('the small retained receipt must match the provider digest and expected archive entry',()=>{
 const result={action:'act_'+'a'.repeat(24),source:'b'.repeat(40),status:'success',imageDigest:digest('image')};
 const data=Buffer.from(JSON.stringify(result)),packed=deflateRawSync(data),name=Buffer.from('claus-result.json'),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
 local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);local.writeUInt32LE(crc32(data),14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
 central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(8,10);central.writeUInt32LE(crc32(data),16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);
 end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(local.length+name.length+packed.length,16);
 const archive=Buffer.concat([local,name,packed,central,name,end]);assert.deepEqual(readBuildReceiptZip(archive,digest(archive)),result);
 const changed=Buffer.from(archive);changed[50]^=1;assert.throws(()=>readBuildReceiptZip(changed,digest(archive)),/archive_integrity/);
});
