import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {requireThat} from '../shared/index.mjs';
import {readOciLayout} from './oci-layout.mjs';

export const MAX_IMAGE_BYTES=134217728;
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

// Read the one fixed Actions entry in memory. Never extract filesystem paths.
export function imageFromZip(bytes,receipt){
 const check=(ok)=>requireThat(ok,'oci_image_archive_invalid');
 check(Buffer.isBuffer(bytes)&&bytes.length>=22&&bytes.length<=MAX_IMAGE_BYTES+65536);
 check('sha256:'+sha256(bytes)===receipt.artifact?.digest);
 let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
 check(end>=0&&end+22+bytes.readUInt16LE(end+20)===bytes.length);
 check(bytes.readUInt16LE(end+4)===0&&bytes.readUInt16LE(end+6)===0&&bytes.readUInt16LE(end+8)===1&&bytes.readUInt16LE(end+10)===1);
 const at=bytes.readUInt32LE(end+16),centralSize=bytes.readUInt32LE(end+12);
 check(at+46<=end&&at+centralSize===end&&bytes.readUInt32LE(at)===0x02014b50);
 const flags=bytes.readUInt16LE(at+8),method=bytes.readUInt16LE(at+10),size=bytes.readUInt32LE(at+20),rawSize=bytes.readUInt32LE(at+24),nameSize=bytes.readUInt16LE(at+28),offset=bytes.readUInt32LE(at+42);
 check(!(flags&1)&&[0,8].includes(method)&&size<=MAX_IMAGE_BYTES+32768&&rawSize===receipt.archiveBytes&&rawSize>0&&rawSize<=MAX_IMAGE_BYTES);
 check(46+nameSize+bytes.readUInt16LE(at+30)+bytes.readUInt16LE(at+32)===centralSize&&bytes.readUInt16LE(at+34)===0);
 check(bytes.subarray(at+46,at+46+nameSize).toString()==='image.tar');
 check(offset===0&&offset+30<=at&&bytes.readUInt32LE(offset)===0x04034b50&&bytes.readUInt16LE(offset+8)===method);
 const localName=bytes.readUInt16LE(offset+26),start=offset+30+localName+bytes.readUInt16LE(offset+28);
 check(bytes.subarray(offset+30,offset+30+localName).toString()==='image.tar'&&start+size<=at);
 const packed=bytes.subarray(start,start+size),raw=method===8?inflateRawSync(packed,{maxOutputLength:MAX_IMAGE_BYTES}):packed;
 check(raw.length===rawSize&&'sha256:'+sha256(raw)===receipt.archiveHash);
 return raw;
}

export function createImageArchive({objects,now=()=>Date.now()}){
 const scope=projectId=>'oci-'+sha256(projectId);
 function reference(receipt){
  requireThat(/^sha256:[a-f0-9]{64}$/.test(receipt.archiveHash)&&Number.isSafeInteger(receipt.archiveBytes)&&receipt.archiveBytes>0&&receipt.archiveBytes<=MAX_IMAGE_BYTES,'oci_image_receipt_invalid');
  return receipt.archiveHash.slice(7);
 }
 return {
  enabled:!!objects,
  async publish(projectId,receipt){
   requireThat(objects&&receipt.storage?.state==='verified','oci_image_storage_unavailable');
   const original=await objects.read(scope(projectId),reference(receipt));
   requireThat(original.state==='verified'&&original.length===receipt.archiveBytes,'oci_image_storage_mismatch');
   const layout=readOciLayout(original.bytes,receipt.imageDigest),members=[];
   for(const {bytes,...member} of layout.members){
    const namespace='registry-'+sha256(projectId),prior=await objects.read(namespace,member.digest.slice(7));
    if(prior.state!=='verified'){
     requireThat(prior.state==='not_found','oci_image_storage_unavailable');
     const saved=await objects.put(namespace,bytes);
     requireThat(saved.state==='verified'&&saved.sha256===member.digest.slice(7)&&saved.bytes===member.size,'oci_image_storage_mismatch');
    }else requireThat(prior.length===member.size,'oci_image_storage_mismatch');
    members.push(member);
   }
   return {profile:'public-oci-v1',imageDigest:layout.imageDigest,archiveHash:receipt.archiveHash,members};
  },
  async registryRead(projectId,member){
   requireThat(objects,'oci_image_storage_unavailable');
   const namespace='registry-'+sha256(projectId),key=member.digest.slice(7);
   if(member.manifest){
    const value=await objects.read(namespace,key);
    requireThat(value.state==='verified'&&value.length===member.size,'oci_image_storage_mismatch');return {bytes:value.bytes};
   }
   return objects.download(namespace,key,{filename:key,contentType:'application/octet-stream',expiresIn:60});
  },
  async preserve(projectId,receipt,download){
   requireThat(objects,'oci_image_storage_unavailable');const hash=reference(receipt),namespace=scope(projectId);
   const prior=await objects.read(namespace,hash);
   if(prior.state!=='verified'){
    requireThat(prior.state==='not_found','oci_image_storage_unavailable');
    const bytes=imageFromZip(await download(),receipt);
    const saved=await objects.put(namespace,bytes);
    requireThat(saved.state==='verified'&&saved.sha256===hash&&saved.bytes===receipt.archiveBytes,'oci_image_storage_mismatch');
   }else requireThat(prior.length===receipt.archiveBytes,'oci_image_storage_mismatch');
   return {profile:'private-r2-oci-v1',state:'verified',archiveHash:receipt.archiveHash,bytes:receipt.archiveBytes,verifiedAt:now(),expiresAt:null};
  },
  async download(projectId,receipt){
   requireThat(objects&&receipt.storage?.state==='verified','oci_image_storage_unavailable');
   const hash=reference(receipt);
   requireThat(receipt.storage.archiveHash===receipt.archiveHash&&receipt.storage.bytes===receipt.archiveBytes,'oci_image_storage_mismatch');
   return objects.download(scope(projectId),hash,{filename:'image.tar',contentType:'application/x-tar',expiresIn:60});
  }
 };
}
