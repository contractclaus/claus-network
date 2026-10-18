// Exact byte handling shared by the runtime and its publication custodian.
export const binaryPath=path=>/\.(?:png|jpe?g|webp|gif|avif|ico|pdf|zip|gz|woff2?|ttf|otf|mp[34]|webm|ogg|wav|wasm|zkey|r1cs|bin)$/i.test(path);
export const webPath=path=>path==='.vercelignore'||typeof path==='string'&&path.length<=240&&!path.split('/').some(x=>!x||x==='.'||x==='..'||x.startsWith('.'))&&!/(?:^|\/)(?:node_modules|secrets?|credentials?|private)(?:\/|\.)/i.test(path)&&/^[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|html|css|svg|txt|xml|webmanifest|map|sql|png|jpe?g|webp|gif|avif|ico|pdf|zip|gz|woff2?|ttf|otf|mp[34]|webm|ogg|wav|wasm|zkey|r1cs|bin)$/i.test(path);
export function bytes(value,encoding){
 if(typeof value!=='string')throw Error('operations_file_content_invalid');
 if(encoding!=='base64')return Buffer.from(value,'utf8');
 if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw Error('operations_base64_invalid');
 const result=Buffer.from(value,'base64');if(result.toString('base64')!==value)throw Error('operations_base64_invalid');return result;
}
export function checkFileChange(scope,c,allowed){
 if(!c||typeof c.path!=='string'||!allowed(c.path)||c.path.split('/').some(x=>!x||x==='.'||x==='..')||typeof c.before!=='string'||typeof c.after!=='string')throw Error('operations_path_or_change_denied');
 if(c.assetId!==undefined&&(!/^asset_[a-f0-9]{32}$/.test(c.assetId)||scope!=='web'||!binaryPath(c.path)||c.action!=='replace'||c.encoding!=='base64'||c.before!==''||c.after!==''))throw Error('operations_asset_invalid');
 const action=c.action??'patch';if(!['patch','replace','delete'].includes(action)||c.encoding!==undefined&&c.encoding!=='base64'||c.expectedSha!==undefined&&!/^[a-f0-9]{40}$/.test(c.expectedSha))throw Error('operations_file_change_invalid');
 if((action!=='patch'||c.encoding)&&scope!=='web')throw Error('operations_file_change_scope_denied');
 if(binaryPath(c.path)!==(c.encoding==='base64'))throw Error('operations_file_encoding_required');
 if(c.encoding&&action==='patch'||action==='delete'&&(c.after!==''||!c.expectedSha)||action==='patch'&&c.before===c.after)throw Error('operations_file_change_invalid');
 if(bytes(c.before,c.encoding).length+bytes(c.after,c.encoding).length>2000000)throw Error('operations_source_too_large');
}
export function applyChange(ref,before,c,sha,index,asset){
 const encoding=c.encoding,action=c.action??'patch';
 if(c.assetId||encoding==='base64'&&action==='delete'&&before===''){
  if(ref&&c.expectedSha!==ref.sha||!ref&&(c.expectedSha||action==='delete'))throw Error('operations_file_revision_conflict');
  if(c.assetId&&(!asset||asset.id!==c.assetId||!/^[a-f0-9]{40}$/.test(asset.sha)||!Number.isSafeInteger(asset.size)||asset.size<0||asset.size>25000000))throw Error('operations_asset_invalid');
  return {path:c.path,before:'',content:'',encoding:'base64',...(ref?{oldRef:{...ref},index}:{created:true}),...(action==='delete'?{deleted:true}:{asset})};
 }
 const old=bytes(before,encoding);
 if(ref&&(sha(old)!==ref.sha||old.length!==ref.size))throw Error('operations_source_binding');
 if(c.expectedSha!==undefined&&c.expectedSha!==ref?.sha)throw Error('operations_file_revision_conflict');
 if(!ref&&(c.before!==''||action==='delete'))throw Error('operations_new_file_conflict');
 let content;
 if(action==='delete')content='';
 else if(action==='replace'){
  if(ref&&!c.expectedSha)throw Error('operations_expected_sha_required');content=c.after;
 }else{
  if(c.before===''){if(before!=='')throw Error('operations_new_file_conflict');content=c.after;}
  else{const at=before.indexOf(c.before);if(at<0||before.indexOf(c.before,at+c.before.length)>=0)throw Error('operations_patch_not_unique');content=before.slice(0,at)+c.after+before.slice(at+c.before.length);}
 }
 const result=bytes(content,encoding);if(result.length>2000000)throw Error('operations_source_too_large');
 return {path:c.path,before,content,...(encoding?{encoding}:{}),...(!ref?{created:true}:{}),...(action==='delete'?{deleted:true,oldRef:{...ref},index}:{} )};
}
export function changedManifest(base,files,sha){const out=structuredClone(base);for(const f of files){const i=out.findIndex(x=>x.path===f.path);if(f.deleted){if(i<0)throw Error('operations_file_missing');out.splice(i,1);}else{const b=bytes(f.content,f.encoding),ref={...(i<0?{}:out[i]),path:f.path,sha:f.asset?.sha??sha(b),size:f.asset?.size??b.length};if(i<0)out.push(ref);else out[i]=ref;}}return out;}
export function previousManifest(r,sha,gitBlobSha){
 const result=r.manifest.filter(f=>!r.files.some(x=>x.path===f.path&&x.created===true)).map(f=>{const old=r.files.find(x=>x.path===f.path);if(!old)return f;if(old.oldRef)return old.oldRef;const b=bytes(old.before,old.encoding);return {...f,sha:sha(b),size:b.length,...(r.scope==='repository'?{gitSha:gitBlobSha(old.before)}:{})};});
 for(const f of r.files.filter(x=>x.deleted).sort((a,b)=>a.index-b.index)){if(!f.oldRef||f.oldRef.path!==f.path||f.before!==''&&f.oldRef.sha!==sha(bytes(f.before,f.encoding)))throw Error('operations_deleted_source_binding');result.splice(f.index,0,f.oldRef);}return result;
}
export function schedulesFor(r,current){
 const changed=r.files.find(f=>f.path==='vercel.json');if(!changed)return current;
 if(changed.deleted)throw Error('operations_config_deletion_denied');
 const config=JSON.parse(changed.content),crons=config.crons??[];
 if(!Array.isArray(crons)||crons.length>100||crons.some(c=>!c||typeof c.path!=='string'||!/^\/[A-Za-z0-9_/-]+$/.test(c.path)||typeof c.schedule!=='string'||c.schedule.trim().split(/\s+/).length!==5||!/^[\d*\/,\-\s]+$/.test(c.schedule))||new Set(crons.map(c=>c.path)).size!==crons.length)throw Error('operations_schedule_invalid');
 return crons.map(({path,schedule})=>({path,schedule}));
}
