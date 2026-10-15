import {copy,digest,integer,requireThat,text,sourceText} from '../shared/index.mjs';

// Declared relationships, never an inferred endorsement or a permission grant.
export function createDependencies({store,identity,visible,admit,now=()=>Date.now()}){
 async function publicProject(id,reader=store){
  const p=(await reader.read('projects',id))?.value;
  requireThat(p&&!p.archivedAt&&!p.transfer&&await visible(id,reader)&&(await reader.read('public-projects',p.slug))?.value.published,'not_found');
  return {id,name:p.name,url:'/c/'+p.slug};
 }
 async function view(row,reader=store){
  const project=await publicProject(row.value.projectId,reader),items=[];
  for(const item of row.value.items){try{items.push({...copy(item),project:await publicProject(item.projectId,reader)});}catch(e){if(e.code!=='not_found')throw e;}}
  return {project,items,revision:row.revision,updatedAt:row.value.updatedAt,meaning:'Declared by this project. No endorsement, live availability or access permission is implied.'};
 }
 return {
  async set(actor,projectId,{items,expectedRevision,idempotencyKey}){
   integer(expectedRevision);text(idempotencyKey);requireThat(idempotencyKey.length<=128&&Array.isArray(items)&&items.length<=16,'invalid_dependencies');
   const seen=new Set();for(const item of items){requireThat(item&&Object.keys(item).sort().join(',')==='kind,note,projectId','invalid_dependency');text(item.projectId);sourceText(item.note,240);requireThat(item.projectId!==projectId&&!seen.has(item.projectId)&&['service','data','application'].includes(item.kind),'invalid_dependency');seen.add(item.projectId);}
   return store.transaction(async tx=>{
    await identity.authorize(actor,'project.publish',{projectId},tx);await admit(projectId,tx);
    for(const item of items)await publicProject(item.projectId,tx);
    const who=await identity.credential(actor,tx),key=digest({projectId,actor:who.principalId,idempotencyKey}),hash=digest({items,expectedRevision}),prior=await tx.read('dependency-requests',key);
    if(prior){requireThat(prior.value.hash===hash,'idempotency_conflict');return prior.value.result;}
    const row=await tx.write('project-dependencies',projectId,{projectId,items:copy(items),updatedAt:now()},expectedRevision),result={...copy(row.value),revision:row.revision};
    await tx.write('dependency-requests',key,{projectId,hash,result},0);return result;
   });
  },
  async get(projectId){await publicProject(projectId);const row=await store.read('project-dependencies',projectId);return row?view(row):{project:await publicProject(projectId),items:[],revision:0};},
  async impact(projectId,{after='',limit=20}={}){
   await publicProject(projectId);integer(limit,1,25);let start='';
   if(after){let parsed;try{parsed=JSON.parse(Buffer.from(after,'base64url').toString());}catch{}requireThat(parsed?.projectId===projectId&&typeof parsed.last==='string','invalid_cursor');start=parsed.last;}
   const rows=await store.list('project-dependencies',{after:start,limit}),items=[];
   for(const row of rows){if(!row.value.items.some(i=>i.projectId===projectId))continue;try{const r=await view(row);items.push({project:r.project,dependency:r.items.find(i=>i.projectId===projectId),updatedAt:r.updatedAt});}catch(e){if(e.code!=='not_found')throw e;}}
   return {projectId,items,nextCursor:rows.length===limit?Buffer.from(JSON.stringify({projectId,last:rows.at(-1).id})).toString('base64url'):null,scope:'Direct, currently public, declared dependants only. Continue empty pages when a cursor is present.'};
  }
 };
}
