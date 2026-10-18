const fail=c=>{throw Error('resource_repository_grant_'+c);};
const path=v=>typeof v==='string'&&v.length>0&&v.length<=240&&!v.startsWith('/')&&!v.includes('\\')&&v.split('/').filter((x,i,a)=>!(i===a.length-1&&x==='')).every(x=>x&&x!=='.'&&x!=='..'&&x!=='.git')&&!/(^|\/)(?:\.github(?:\/|$)|\.env(?:\.|$)|\.npmrc$|\.netrc$|id_rsa$|id_ed25519$)/.test(v);
export function validateRepositoryScopes(scopes,resourceIds,operations){
 const needed=operations.some(x=>['repository_file','repository_write'].includes(x));
 if(scopes===undefined){if(needed)fail('scope_required');return [];}
 if(!Array.isArray(scopes)||scopes.length>20||needed&&!scopes.length)fail('scope_invalid');
 const seen=new Set();
 for(const s of scopes){
  if(!s||Object.keys(s).some(k=>!['resourceId','branch','paths'].includes(k))||!resourceIds.includes(s.resourceId)||!/^claus-worker-[a-f0-9]{24}$/.test(s.branch??'')||!Array.isArray(s.paths)||!s.paths.length||s.paths.length>50||s.paths.some(p=>!path(p)))fail('scope_invalid');
  const key=s.resourceId+':'+s.branch;if(seen.has(key))fail('duplicate_scope');seen.add(key);
 }
 return scopes;
}
export function authorizeRepositoryScope(rules,operation,input){
 if(!['repository_file','repository_write'].includes(operation))return;
 const branch=operation==='repository_file'?input.ref:input.branch;
 if(!path(input.path)||!rules.repositoryScopes?.some(s=>s.resourceId===input.resourceId&&s.branch===branch&&s.paths.some(p=>p.endsWith('/')?input.path.startsWith(p):input.path===p)))fail('path_or_branch_denied');
}
