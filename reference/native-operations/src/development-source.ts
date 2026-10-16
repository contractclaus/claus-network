import {createHash} from 'node:crypto';

export type DevelopmentSource={projectId:string;releaseId:string;prefix:string};
export type SourceFile={path:string;content:string};
export const SOURCE_LIMITS=Object.freeze({files:256,bytes:3000000});
export function sourcePath(path:unknown):path is string {
 return typeof path==='string'&&path.length>0&&path.length<=240&&!path.startsWith('/')&&!path.includes('\\')&&!/[\x00-\x1f]/.test(path)&&!path.split('/').some(p=>!p||p==='.'||p==='..');
}
export function developmentSource(value:any):DevelopmentSource {
 if(!value||Object.keys(value).some(k=>!['projectId','releaseId','prefix'].includes(k))||!/^prj_[A-Za-z0-9_-]{1,100}$/.test(value.projectId)||!/^sha256:[a-f0-9]{64}$/.test(value.releaseId)||!sourcePath(value.prefix)||value.prefix.length>100)throw Error('development_source_invalid');
 return value;
}
const canonical=(value:any):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
const hash=(value:any)=>'sha256:'+createHash('sha256').update(canonical(value)).digest('hex');
export function importRelease(source:DevelopmentSource,release:any):SourceFile[] {
 developmentSource(source);
 if(release?.projectId!==source.projectId||release.id!==source.releaseId||!Array.isArray(release.files)||!release.files.length||release.files.length>SOURCE_LIMITS.files)throw Error('development_source_mismatch');
 const seen=new Set<string>();let size=0;
 const files=release.files.map((f:any)=>{
  if(!f||Object.keys(f).some(k=>!['path','content','hash'].includes(k))||!sourcePath(f.path)||!sourcePath(source.prefix+'/'+f.path)||seen.has(f.path)||typeof f.content!=='string'||hash({path:f.path,content:f.content})!==f.hash)throw Error('development_source_file_invalid');
  seen.add(f.path);size+=Buffer.byteLength(f.content);
  if(size>SOURCE_LIMITS.bytes)throw Error('development_source_too_large');
  return {path:source.prefix+'/'+f.path,content:f.content};
 });
 if(hash(release.files)!==release.contentHash)throw Error('development_source_hash_mismatch');
 return files;
}

// Guest-only writer: imported source never runs on the host or receives keys.
// Clear the inherited Solidity template only for a genuinely new workspace.
export function developmentWriter(fresh:boolean){return `import fs from 'node:fs';import path from 'node:path';const root='/vercel/sandbox/project';${fresh?"fs.rmSync(root,{recursive:true,force:true});":''}if(fs.existsSync(root)&&fs.lstatSync(root).isSymbolicLink())throw Error('symlink_write_denied');fs.mkdirSync(root,{recursive:true});for(const f of JSON.parse(fs.readFileSync('/tmp/claus-development-input.json','utf8'))){let p=root;for(const part of f.path.split('/')){p=path.join(p,part);try{if(fs.lstatSync(p).isSymbolicLink())throw Error('symlink_write_denied');}catch(e){if(e.code!=='ENOENT')throw e;}}const dest=path.join(root,f.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,f.content);}`;}
