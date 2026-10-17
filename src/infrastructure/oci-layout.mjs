import {createHash} from 'node:crypto';
import {requireThat} from '../shared/index.mjs';

const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const indexes=new Set(['application/vnd.oci.image.index.v1+json','application/vnd.docker.distribution.manifest.list.v2+json']);
const manifests=new Set(['application/vnd.oci.image.manifest.v1+json','application/vnd.docker.distribution.manifest.v2+json']);
const check=ok=>requireThat(ok,'oci_layout_invalid');
const string=b=>b.subarray(0,b.indexOf(0)<0?b.length:b.indexOf(0)).toString('utf8');
function octal(b){const s=string(b).trim();check(/^[0-7]+$/.test(s));const n=parseInt(s,8);check(Number.isSafeInteger(n));return n;}
function json(bytes){check(bytes&&bytes.length<=262144);try{return JSON.parse(bytes.toString('utf8'));}catch{check(false);}}

// Parse, never extract, an OCI tar. Layer tarballs remain opaque hashed blobs.
// Only reachable descriptors are published, never extra files in the archive.
export function readOciLayout(archive,imageDigest){
 check(Buffer.isBuffer(archive)&&archive.length>=1024&&archive.length<=33554432&&archive.length%512===0);
 const files=new Map();let ended=false;
 for(let at=0;at<archive.length;){
  const header=archive.subarray(at,at+512);
  if(header.every(x=>x===0)){check(at+1024<=archive.length&&archive.subarray(at).every(x=>x===0));ended=true;break;}
  let checksum=0;for(let i=0;i<512;i++)checksum+=i>=148&&i<156?32:header[i];check(checksum===octal(header.subarray(148,156)));
  const prefix=string(header.subarray(345,500)),name=(prefix?prefix+'/':'')+string(header.subarray(0,100));
  const path=name.startsWith('./')?name.slice(2):name,size=octal(header.subarray(124,136)),type=header[156];
  check([0,48,53].includes(type)&&!string(header.subarray(157,257)));
  check(at+512+Math.ceil(size/512)*512<=archive.length);
  if(type===53)check(size===0&&['blobs','blobs/','blobs/sha256','blobs/sha256/'].includes(path));
  else{
   check(/^(oci-layout|index\.json|blobs\/sha256\/[a-f0-9]{64})$/.test(path)&&!files.has(path)&&files.size<260);
   files.set(path,archive.subarray(at+512,at+512+size));
  }
  at+=512+Math.ceil(size/512)*512;
 }
 check(ended&&json(files.get('oci-layout')).imageLayoutVersion==='1.0.0');
 const index=json(files.get('index.json'));check(index.schemaVersion===2&&Array.isArray(index.manifests));
 // BuildKit returns the digest of the sole exported root descriptor.
 const root=index.manifests.find(d=>d.digest===imageDigest);check(root&&index.manifests.length===1);
 const members=new Map(),visiting=new Set();
 function visit(d,depth=0){
  check(d&&/^sha256:[a-f0-9]{64}$/.test(d.digest)&&Number.isSafeInteger(d.size)&&d.size>=0&&depth<12);
  check(typeof d.mediaType==='string'&&/^application\/[a-zA-Z0-9][a-zA-Z0-9.+_-]{1,126}$/.test(d.mediaType)&&!d.urls);
  if(members.has(d.digest)){check(members.get(d.digest).size===d.size&&members.get(d.digest).mediaType===d.mediaType&&!visiting.has(d.digest));return;}
  const bytes=files.get('blobs/sha256/'+d.digest.slice(7));check(bytes&&bytes.length===d.size&&hash(bytes)===d.digest&&members.size<256);
  const isManifest=indexes.has(d.mediaType)||manifests.has(d.mediaType);
  members.set(d.digest,{digest:d.digest,size:d.size,mediaType:d.mediaType,manifest:isManifest,bytes});
  if(isManifest){
   visiting.add(d.digest);const document=json(bytes);check(document.schemaVersion===2&&(!document.mediaType||document.mediaType===d.mediaType));
   if(indexes.has(d.mediaType)){check(Array.isArray(document.manifests)&&document.manifests.length>0);for(const child of document.manifests)visit(child,depth+1);}
   else{check(Array.isArray(document.layers));visit(document.config,depth+1);for(const child of document.layers)visit(child,depth+1);}
   visiting.delete(d.digest);
  }
 }
 check(indexes.has(root.mediaType)||manifests.has(root.mediaType));visit(root);
 check(Buffer.byteLength(JSON.stringify([...members.values()].map(({bytes,...m})=>m)))<=48000);
 return {imageDigest,members:[...members.values()]};
}
