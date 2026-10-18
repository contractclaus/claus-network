import {digest} from './store.mjs';
const fail=c=>{throw Error('resource_asset_'+c);};
const name=v=>typeof v==='string'&&/^[a-z][a-z0-9-]{1,99}$/.test(v);
const clean=(v,n)=>typeof v==='string'&&v.trim().length>0&&v.length<=n&&!/-----BEGIN|Bearer\s|(?:token|secret|password|api[-_]?key)\s*[=:]\s*\S{8}/i.test(v);
const version=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
const filePath=v=>typeof v==='string'&&v.length<=240&&/^[A-Za-z0-9._/-]+$/.test(v)&&!v.startsWith('/')&&v.split('/').every(p=>p&&p!=='.'&&p!=='..');
export const assetInputs={assets:['query','offset'],asset_read:['name','version'],asset_publish:['name','expectedRevision','kind','description','license','source','files','parents','workId'],asset_export:['name','version'],asset_diff:['name','fromVersion','toVersion'],asset_retire:['name','expectedRevision','reason']};
export function managedAssets({store,workStatus,now=Date.now}){
 const stamp=()=>new Date(now()).toISOString();
 const metadata=a=>({name:a.name,revision:a.revision,version:a.version,kind:a.kind,description:a.description,status:a.status,fileCount:a.files.length,bytes:a.files.reduce((n,f)=>n+f.bytes,0),expiresAt:a.expiresAt,workId:a.workId,updatedAt:a.updatedAt,instructionAuthority:false});
 async function head(id){if(!name(id))fail('name_invalid');const a=await store.get('asset',id);if(!a)fail('not_found');return a;}
 async function read(id,v){
  const a=await head(id);if(v===undefined||v===a.version)return a;
  if(!version(v))fail('version_invalid');
  const old=await store.get('asset-version',id+':'+v),published=await store.get('asset-publication',id+':'+v);
  if(!old||!published)fail('version_unpublished');return old;
 }
 async function observations(a){
  const files=[];
  for(const f of a.files){const r=await store.get('resource',f.resourceId),o=await store.get('object',f.objectId);const available=r?.provider==='r2'&&r.status!=='removed'&&o?.resourceId===f.resourceId&&o.state==='ready'&&o.sha256===f.sha256&&o.bytes===f.bytes&&Date.parse(o.expiresAt)>now();files.push({...f,available:!!available,state:o?.state??'missing',expiresAt:o?.expiresAt??null});}
  return {files,available:a.status==='active'&&files.every(f=>f.available),observedAt:stamp(),meaning:'Availability follows verified owned objects and their recorded retention. This does not infer rights to source data or extend object lifetime.'};
 }
 async function file(input){
  if(!exact(input,['path','resourceId','objectId','sha256'])||!filePath(input.path)||!/^res_[a-f0-9]{24}$/.test(input.resourceId??'')||!/^obj_[a-f0-9]{24}$/.test(input.objectId??'')||!version(input.sha256))fail('file_invalid');
  const r=await store.get('resource',input.resourceId),o=await store.get('object',input.objectId);
  if(r?.provider!=='r2'||r.status==='removed'||o?.resourceId!==r.id||o.state!=='ready'||o.sha256!==input.sha256||!Number.isSafeInteger(o.bytes)||o.bytes<1||!Number.isFinite(Date.parse(o.expiresAt))||Date.parse(o.expiresAt)<=now())fail('verified_object_required');
  return {...input,bytes:o.bytes,expiresAt:o.expiresAt,verifiedAt:o.verifiedAt};
 }
 async function archive(a){await store.put('asset-version',a.name+':'+a.version,a);await store.put('asset-publication',a.name+':'+a.version,{version:a.version,revision:a.revision,at:a.updatedAt});await store.put('asset-transition',a.lastAction,{name:a.name,version:a.version,revision:a.revision,status:a.status});}
 async function call(operation,input,requestId){
  if(operation==='assets'){
   const offset=input.offset??0;if(!Number.isSafeInteger(offset)||offset<0||input.query!==undefined&&!clean(input.query,240))fail('page_invalid');
   const p=await store.list('asset',offset),q=(input.query??'').toLowerCase();return {...p,items:p.items.filter(a=>(a.name+' '+a.description).toLowerCase().includes(q)).map(metadata),instructionAuthority:false};
  }
  if(operation==='asset_read'||operation==='asset_export'){
   const a=await read(input.name,input.version),observation=await observations(a);
   if(operation==='asset_read')return {...a,observation,instructionAuthority:false};
   // Export is a portable manifest, not a new copy or longer retention.
   return {format:'claus-asset-v1',manifest:{name:a.name,version:a.version,kind:a.kind,description:a.description,license:a.license,source:a.source,visibility:'private',parents:a.parents,files:a.files,workId:a.workId,createdAt:a.createdAt},observation,download:'Use object_download for each available file with its original resourceId/objectId. It returns a short-lived link; keep the recorded SHA256 with the exported file.',instructionAuthority:false};
  }
  if(operation==='asset_diff'){
   if(!version(input.fromVersion)||!version(input.toVersion))fail('version_invalid');
   const from=await read(input.name,input.fromVersion),to=await read(input.name,input.toVersion),left=new Map(from.files.map(f=>[f.path,f])),right=new Map(to.files.map(f=>[f.path,f]));
   return {name:input.name,fromVersion:from.version,toVersion:to.version,added:to.files.filter(f=>!left.has(f.path)).map(f=>f.path),removed:from.files.filter(f=>!right.has(f.path)).map(f=>f.path),changed:to.files.filter(f=>left.has(f.path)&&left.get(f.path).sha256!==f.sha256).map(f=>f.path),metadataChanged:['kind','description','license','source'].filter(k=>digest(from[k])!==digest(to[k])),instructionAuthority:false};
  }
  if(!clean(requestId,200)||!name(input.name)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)fail('request_invalid');
  const id='act_'+digest(['owner',requestId]).slice(0,24),previous=await store.get('action',id);
  if(previous&&(previous.operation!==operation||digest(previous.input)!==digest(input)))fail('request_conflict');
  if(previous?.output)return previous.output;
  let p=previous?.prepared;
  if(!p){
   const before=await store.get('asset',input.name);if((before?.revision??0)!==input.expectedRevision)fail('revision_conflict');
   if(before)await archive(before);
   if(operation==='asset_retire'){
    if(!before||before.status!=='active'||!clean(input.reason,2000))fail('retirement_invalid');
    p={...before,status:'retired',retirementReason:input.reason,revision:before.revision+1,updatedAt:stamp(),lastAction:id};
   }else if(operation==='asset_publish'){
    if(!['dataset','checkpoint','model','document','export'].includes(input.kind)||!clean(input.description,2000)||!clean(input.license,1200)||!clean(input.source,4000)||!Array.isArray(input.files)||!input.files.length||input.files.length>1000||new Set(input.files.map(f=>f?.path)).size!==input.files.length||!Array.isArray(input.parents)||input.parents.length>100)fail('definition_invalid');
    if(input.workId!==undefined&&(!/^nw_[a-z0-9_-]{1,80}$/.test(input.workId)||!['ready','working','waiting'].includes(await workStatus(input.workId))))fail('work_inactive');
    const files=[];for(const f of input.files)files.push(await file(f));files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
    const parents=[];for(const ref of input.parents){if(!exact(ref,['name','version'])||!name(ref.name)||!version(ref.version))fail('parent_invalid');const a=await read(ref.name,ref.version);parents.push({name:a.name,version:a.version,kind:a.kind});}
    if(new Set(parents.map(p=>p.name+':'+p.version)).size!==parents.length)fail('parent_invalid');
    parents.sort((a,b)=>(a.name+':'+a.version).localeCompare(b.name+':'+b.version,'en'));
    const body={name:input.name,kind:input.kind,description:input.description,license:input.license,source:input.source,visibility:'private',files,parents,workId:input.workId??null,previousVersion:before?.version??null};
    const createdAt=stamp();p={...body,version:digest(body),status:'active',revision:input.expectedRevision+1,createdAt,updatedAt:createdAt,expiresAt:new Date(Math.min(...files.map(f=>Date.parse(f.expiresAt)))).toISOString(),lastAction:id};
   }else fail('operation_invalid');
   p=(await store.begin(id,operation,input,p)).row.result.prepared;
  }
  let current=await store.get('asset',p.name);
  if(current?.lastAction!==id){
   if((current?.revision??0)!==input.expectedRevision){
    const applied=await store.get('asset-transition',id);
    if(!applied||applied.name!==p.name||applied.version!==p.version||applied.revision!==p.revision||applied.status!==p.status)fail('revision_conflict');
   }else if(current){await archive(current);current=await store.change('asset',p.name,current.revision,p);}
   else {const saved=await store.put('asset',p.name,p);current=saved.value;if(current.lastAction!==id)fail('revision_conflict');}
  }
  await archive(p);
  return store.complete(id,{id,asset:metadata(p),historyRetained:true,filesRemoved:false,meaning:operation==='asset_retire'?'Retirement prevents selecting this head as active. Files keep their original object retention until explicitly removed; historical manifests remain available.':'Version records verified object bytes and operator-declared provenance/rights. Publishing a manifest does not train a model or prove source licensing.'});
 }
 return {call};
}
