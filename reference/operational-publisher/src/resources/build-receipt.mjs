import {inflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const fail=c=>{throw Error('resource_build_receipt_'+c);};
// Read one small provider artifact; never unpack arbitrary paths to disk.
export function readBuildReceiptZip(bytes,expectedDigest){
 if(bytes.length>1000000||'sha256:'+createHash('sha256').update(bytes).digest('hex')!==expectedDigest)fail('archive_integrity');
 let end=-1;for(let at=bytes.length-22;at>=Math.max(0,bytes.length-65557);at--)if(bytes.readUInt32LE(at)===0x06054b50){end=at;break;}
 if(end<0||bytes.readUInt16LE(end+8)!==1||bytes.readUInt16LE(end+10)!==1)fail('archive_entries');
 const central=bytes.readUInt32LE(end+16);if(central+46>bytes.length||bytes.readUInt32LE(central)!==0x02014b50)fail('archive_directory');
 const size=bytes.readUInt32LE(central+24),packed=bytes.readUInt32LE(central+20),method=bytes.readUInt16LE(central+10),flags=bytes.readUInt16LE(central+8),nameLength=bytes.readUInt16LE(central+28),offset=bytes.readUInt32LE(central+42);
 if(size>16000||packed>100000||flags&1||![0,8].includes(method)||bytes.subarray(central+46,central+46+nameLength).toString()!=='claus-result.json'||offset+30>bytes.length||bytes.readUInt32LE(offset)!==0x04034b50)fail('archive_entry');
 const start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28);if(start+packed>central)fail('archive_bounds');
 const raw=method===0?bytes.subarray(start,start+packed):inflateRawSync(bytes.subarray(start,start+packed),{maxOutputLength:16000});if(raw.length!==size)fail('archive_size');
 return JSON.parse(raw.toString());
}
