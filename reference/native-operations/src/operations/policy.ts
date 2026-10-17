import {createHash} from 'node:crypto';
export type FileRef={path:string;sha:string;size:number};
export type Change={path:string;before:string;after:string};
export const OPS_TARGETS={
 web:{project:'prj_3EPhg3tuhf5oHU9sw2Butj9eRegy',name:'claus',origin:'https://claus.si',probe:'/Network',paths:[/^docs\/[a-z0-9-]+\.(?:html|md)$/, /^assets\/network-[a-z0-9-]+\.(?:css|js)$/]},
 api:{project:'prj_rGom8c2zwC8zztmqsSFPaAJj7fXs',name:'claus-network-api',origin:'https://claus-network-api.vercel.app',probe:'/health',paths:[/^src\/isolated\/network\.json$/, /^src\/application\/main\.js$/]},
 native:{project:'prj_JQEQJQb3Obhgas8Dtx0FIe1Zokah',name:'claus-agent',origin:'https://claus-agent.vercel.app',probe:'/health',paths:[/^src\/isolated\/(?:network|work)\.json$/, /^src\/application\/main\.js$/]}
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
 if(!Array.isArray(changes)||!changes.length||changes.length>8||changes.some(c=>!c||typeof c!=='object'))throw new OperationsInputRejection('operations_changes_invalid','Provide 1..8 file changes, each with path, before and after.');
 if(new Set(changes.map(x=>x.path)).size!==changes.length)throw new OperationsInputRejection('operations_changes_invalid','Use one change per file path. Combine multiple edits to the same file into one exact before/after replacement; reread current source and scope revision first.');
 for(const c of changes)if(!c||typeof c.path!=='string'||!p.paths.some(r=>r.test(c.path))||typeof c.before!=='string'||!c.before||typeof c.after!=='string'||c.before===c.after||Buffer.byteLength(c.before)+Buffer.byteLength(c.after)>40000)throw new OperationsInputRejection('operations_path_or_change_denied','Use a listed editable path, nonempty exact before text and different after text within the existing size limit.');
}
export function patch(content:string,c:Change){const at=content.indexOf(c.before);if(at<0||content.indexOf(c.before,at+c.before.length)>=0)throw Error('operations_patch_not_unique');const result=content.slice(0,at)+c.after+content.slice(at+c.before.length);if(Buffer.byteLength(result)>400000)throw Error('operations_source_too_large');return result;}
export function denyNewAuthority(before:string,after:string){
 // Structural scope plus independent review, not a claim of arbitrary-JS isolation.
 const dangerous=[/process\s*\.\s*env/g,/\b(?:eval|Function)\s*\(/g,/\b(?:child_process|node:fs|node:net|node:tls|node:vm|node:module)\b/g,/\b(?:WALLET_SECRET|SIGNER_PRIVATE_KEY|RELEASE_SECRET|OPERATOR_SECRET)\b/g];
 for(const r of dangerous)if([...after.matchAll(r)].length>[...before.matchAll(r)].length)throw Error('operations_authority_expansion_denied');
}
