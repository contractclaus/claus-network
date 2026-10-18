import {webPath,checkFileChange,previousManifest} from './files.mjs';
import {createHash} from 'node:crypto';
export type FileRef={path:string;sha:string;size:number;gitSha?:string};
export type Change={path:string;before:string;after:string;action?:'patch'|'replace'|'delete';encoding?:'base64';expectedSha?:string;assetId?:string};
export const OPS_TARGETS={
 repository:{project:'contractclaus/claus-network',name:'claus-network',origin:'https://github.com/contractclaus/claus-network',probe:'/README.md',paths:[/^(?:README\.md|(?:src|runtime|api|adapters|interfaces|scripts|test|tests|docs)\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx|json|md|sql)|package(?:-lock)?\.json|tsconfig(?:\.[a-z-]+)?\.json|vercel\.json|modules\.json|[A-Za-z0-9_-]+\.config\.(?:js|mjs|ts))$/]},
 web:{project:'prj_3EPhg3tuhf5oHU9sw2Butj9eRegy',name:'claus',origin:'https://claus.si',probe:'/Network',paths:[{test:webPath}]},
 api:{project:'prj_rGom8c2zwC8zztmqsSFPaAJj7fXs',name:'claus-network-api',origin:'https://claus-network-api.vercel.app',probe:'/health',paths:[/^(?:(?:src|runtime|api|adapters|interfaces|scripts|tests?|docs)\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|mts|cts|ts|json|md|sql)|package(?:-lock)?\.json|tsconfig(?:\.[a-z-]+)?\.json|vercel\.json|modules\.json|[A-Za-z0-9_-]+\.config\.(?:js|mjs|ts))$/]},
 native:{project:'prj_JQEQJQb3Obhgas8Dtx0FIe1Zokah',name:'claus-agent',origin:'https://claus-agent.vercel.app',probe:'/health',paths:[/^(?:(?:src|api|scripts|tests?|docs)\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|mts|cts|ts|json|md|sql)|package(?:-lock)?\.json|tsconfig(?:\.[a-z-]+)?\.json|vercel\.json|modules\.json|[A-Za-z0-9_-]+\.config\.(?:js|mjs|ts))$/]}
} as const;
export type Target=keyof typeof OPS_TARGETS;
export function target(value:string){if(!Object.hasOwn(OPS_TARGETS,value))throw Error('operations_target_invalid');return OPS_TARGETS[value as Target];}
export const sha=(v:string|Buffer)=>createHash('sha1').update(v).digest('hex');
export const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function validateManifest(v:unknown): asserts v is FileRef[]{
 if(!Array.isArray(v)||v.length<1||v.length>2500||new Set(v.map(f=>f.path)).size!==v.length||v.some(f=>!f||typeof f.path!=='string'||f.path.length>240||f.path.startsWith('/')||f.path.split('/').some((p:string)=>p==='..'||p==='.')||!/^[a-f0-9]{40}$/.test(f.sha)||!Number.isSafeInteger(f.size)||f.size<0||f.size>25_000_000))throw Error('operations_manifest_invalid');
}
export class OperationsInputRejection extends Error {
 constructor(code:string,readonly guidance:string){super(code);this.name='OperationsInputRejection';}
}
export function inputRejectionResult(error:unknown){
 if(!(error instanceof OperationsInputRejection))return null;
 return {error:error.message,stage:'input_validation',executed:false,guidance:error.guidance,recovery:{outcome:'rejected',automaticRetry:false,meaning:'This invocation stopped before creating a build, reserving a review or writing a release. Keep the original failed attempt. Read current source and revision before correcting the input; do not replay other or uncertain operations.'}};
}
export function validateChanges(scope:string,changes:Change[]){
 const p=target(scope);
 if(!Array.isArray(changes)||!changes.length||changes.length>64||changes.some(c=>!c||typeof c!=='object'))throw new OperationsInputRejection('operations_changes_invalid','Provide 1..64 file changes, each with path, before and after.');
 if(new Set(changes.map(x=>x.path)).size!==changes.length)throw new OperationsInputRejection('operations_changes_invalid','Use one change per file path. Combine multiple edits to the same file into one exact before/after replacement; reread current source and scope revision first.');
 for(const c of changes){try{checkFileChange(scope,c,path=>p.paths.some(r=>r.test(path)));}catch(error){throw new OperationsInputRejection((error as Error).message,'Use an editable path, exact text patch, or for website whole-file replace/delete use the current expectedSha. Binary files require canonical base64 and action replace/delete.');}}
}
export function patch(content:string,c:Change){if(c.before===''){if(content!=='')throw Error('operations_new_file_conflict');return c.after;}const at=content.indexOf(c.before);if(at<0||content.indexOf(c.before,at+c.before.length)>=0)throw Error('operations_patch_not_unique');const result=content.slice(0,at)+c.after+content.slice(at+c.before.length);if(Buffer.byteLength(result)>2000000)throw Error('operations_source_too_large');return result;}
export function denyNewAuthority(before:string,after:string){
 // Structural scope plus independent review, not a claim of arbitrary-JS isolation.
 const dangerous=[/process\s*\.\s*env/g,/\b(?:eval|Function)\s*\(/g,/\b(?:child_process|node:fs|node:net|node:tls|node:vm|node:module)\b/g,/\b(?:WALLET_SECRET|SIGNER_PRIVATE_KEY|RELEASE_SECRET|OPERATOR_SECRET)\b/g];
 for(const r of dangerous)if([...after.matchAll(r)].length>[...before.matchAll(r)].length)throw Error('operations_authority_expansion_denied');
}

export const isolatedPath=(path:string)=>/^src\/isolated\/(?:network|work)\.json$/.test(path)||path==='src/application/main.js';
export const gitBlobSha=(content:string)=>{const bytes=Buffer.from(content);return createHash('sha1').update(Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes])).digest('hex');};
export function baseManifest(release:any):FileRef[]{return previousManifest(release,sha,gitBlobSha);}
