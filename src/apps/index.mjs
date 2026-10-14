import { randomUUID } from 'node:crypto';
import { canonical, copy, digest, integer, requireThat, shape, text } from '../shared/index.mjs';

export const APP_LIMITS=Object.freeze({records:5000,mutationsPerDay:1000,mutationsPerActorDay:200,events:50000,recordBytes:8192,versions:32,members:1000});
const id=()=>randomUUID(), rowValue=row=>row?{...copy(row.value),revision:row.revision}:null;
const name=value=>{requireThat(typeof value==='string'&&/^[a-z][a-z0-9_-]{0,47}$/.test(value),'invalid_app_name');return value;};
const bounded=(s,n)=>{requireThat(typeof s==='string'&&s.length>0&&s.length<=n,'invalid_app_text');return s;};
const cursor=(appId,actor,collection,last)=>Buffer.from(JSON.stringify([appId,actor,collection,last])).toString('base64url');
function afterCursor(value,appId,actor,collection){if(!value)return '';let p;try{p=JSON.parse(Buffer.from(value,'base64url').toString());}catch{}requireThat(Array.isArray(p)&&p.length===4&&p[0]===appId&&p[1]===actor&&p[2]===collection&&typeof p[3]==='string','invalid_cursor');return p[3];}

export function createApps({storage,identity,store,schemaDefinition,schemaValue,now=()=>Date.now(),visible=async()=>true,admit=async()=>{},authorizeOperator,writesEnabled=true}) {
  const ready=()=>requireThat(storage,'apps_not_enabled');
  async function visitor(actor,reader) {
    const who=await identity.credential(actor,reader);
    if(who.kind!=='owner')await identity.authorize(actor,'app.use',{projectId:who.projectId},reader);
    return who.principalId;
  }
  async function manager(actor,projectId,reader){await identity.authorize(actor,'app.manage',{projectId},reader);return (await identity.credential(actor,reader)).principalId;}
  const operator=(actor,reader,action='inspect')=>authorizeOperator(actor,reader,action);
  function validateManifest(m){
    shape(m,['name','description','participation','collections','tasks']);bounded(m.name,80);bounded(m.description,500);requireThat(['open','invite'].includes(m.participation),'invalid_app_participation');
    requireThat(Array.isArray(m.collections)&&m.collections.length<=16,'invalid_app_collections');const names=new Set();
    for(const c of m.collections){shape(c,['id','visibility','schema']);name(c.id);requireThat(c.id!=='tasks'&&!names.has(c.id),'invalid_app_collections');names.add(c.id);requireThat(['public','members','author','admins'].includes(c.visibility),'invalid_app_visibility');schemaDefinition(c.schema);}
    if(m.tasks!==null){shape(m.tasks,['visibility','inputSchema','outputSchema','leaseSeconds']);requireThat(['public','members'].includes(m.tasks.visibility),'invalid_app_visibility');schemaDefinition(m.tasks.inputSchema);schemaDefinition(m.tasks.outputSchema);integer(m.tasks.leaseSeconds,30,3600);}
    requireThat(Buffer.byteLength(canonical(m))<=24000,'document_too_large');
  }
  async function app(tx,projectId,{publicOnly=false}={}){
    const row=await tx.read('meta','app');requireThat(row,'not_found');
    const project=(await tx.network.read('projects',projectId))?.value;requireThat(project&&!project.archivedAt&&!project.transfer,'project_unavailable');
    requireThat(await visible(projectId,tx.network),'not_found');
    if(publicOnly){const pub=(await tx.network.read('public-projects',project.slug))?.value;requireThat(row.value.published&&pub?.published,'not_found');}
    return row;
  }
  async function participant(tx,projectId,actor){const who=await visitor(actor,tx.network),a=await app(tx,projectId);const own=await identity.allowed(actor,'app.manage',{projectId},tx.network);const member=(await tx.read('members',who))?.value;requireThat(own||member?.active,'app_membership_required');return {who,a,own};}
  async function writable(tx,projectId,actor){requireThat(writesEnabled,'app_writes_paused');await admit(projectId,tx.network);
    const usage=await tx.read('meta','usage'),day=Math.floor(now()/86400000),count=usage?.value.day===day?usage.value.count:0;
    requireThat(count<APP_LIMITS.mutationsPerDay,'capacity_reached');await tx.write('meta','usage',{day,count:count+1},usage?.revision??0);
    const row=await tx.read('usage',actor),own=row?.value.day===day?row.value.count:0;requireThat(own<APP_LIMITS.mutationsPerActorDay,'capacity_reached');await tx.write('usage',actor,{day,count:own+1},row?.revision??0);
  }
  async function effect(tx,projectId,actor,op,key,input,run){bounded(key,128);const p=await visitor(actor,tx.network),k=digest({p,op,key}),hash=digest(input),old=await tx.read('requests',k);if(old){requireThat(old.value.hash===hash,'idempotency_conflict');return copy(old.value.result);}if(!['moderate','withdraw','revoke'].includes(op))await writable(tx,projectId,p);const result=await run(p);await tx.write('requests',k,{hash,result},0);return result;}
  async function event(tx,value){const seq=await tx.read('meta','sequence'),next=(seq?.value.next??0)+1;requireThat(next<=APP_LIMITS.events,'capacity_reached');await tx.write('meta','sequence',{next},seq?.revision??0);await tx.write('events',String(next).padStart(12,'0'),{...value,sequence:next,at:now()},0);}
  const api={
    enabled:!!storage,writesEnabled,limits:APP_LIMITS,
    async configure(actor,projectId,{manifest,expectedRevision,idempotencyKey}){ready();validateManifest(manifest);integer(expectedRevision);return storage.transaction(projectId,async tx=>{
      const author=await manager(actor,projectId,tx.network);requireThat(await visible(projectId,tx.network),'not_found');
      return effect(tx,projectId,actor,'configure',idempotencyKey,{manifest,expectedRevision},async()=>{
        const old=await tx.read('meta','app');requireThat((old?.revision??0)===expectedRevision,'revision_conflict');
        // Existing collections are immutable: additions preserve all reader/author promises.
        if(old)for(const c of old.value.manifest.collections)requireThat(manifest.collections.some(n=>n.id===c.id&&digest(n)===digest(c)),'app_schema_migration_required');
        if(old?.value.manifest.tasks)requireThat(digest(old.value.manifest.tasks)===digest(manifest.tasks),'app_schema_migration_required');
        const version=(old?.value.version??0)+1;requireThat(version<=APP_LIMITS.versions,'capacity_reached');
        const value={projectId,manifest:copy(manifest),version,published:old?.value.published??false,updatedAt:now(),authorId:author};
        await tx.write('versions',String(version),value,0);const result=rowValue(await tx.write('meta','app',value,expectedRevision));await event(tx,{type:'app.configured',actorId:author,version});return result;
      });});},
    async publish(actor,projectId,{published,expectedRevision,idempotencyKey}){ready();requireThat(typeof published==='boolean','invalid_publication');return storage.transaction(projectId,async tx=>{await manager(actor,projectId,tx.network);return effect(tx,projectId,actor,published?'publish':'withdraw',idempotencyKey,{published,expectedRevision},async who=>{const a=await app(tx,projectId);const result=rowValue(await tx.write('meta','app',{...a.value,published,updatedAt:now()},expectedRevision));await event(tx,{type:'app.publication',actorId:who,published});return result;});});},
    async describe(projectId,actor=null){ready();const tx=storage.reader(projectId);const a=await app(tx,projectId,{publicOnly:!actor});if(actor)await participant(tx,projectId,actor);return {...rowValue(a),limits:APP_LIMITS,actions:['app_join','app_records','app_record_create','app_record_update',...(a.value.manifest.tasks?['app_task_post','app_task_claim','app_task_deliver','app_task_accept','app_task_cancel']:[]),'app_events'],backend:'managed-records-and-tasks-v1'};},
    async catalog({after='',limit=50}={}){ready();const ids=await storage.catalog({after,limit}),items=[];for(const projectId of ids){try{const a=await api.describe(projectId);items.push({projectId,name:a.manifest.name,description:a.manifest.description,version:a.version});}catch(e){if(!['not_found','project_unavailable'].includes(e.code))throw e;}}return {items,nextCursor:ids.length===limit?ids.at(-1):null};},
    async join(actor,projectId,{idempotencyKey}) {
      ready();
      return storage.transaction(projectId,async tx=>{
        const who=await visitor(actor,tx.network),a=await app(tx,projectId,{publicOnly:true});
        requireThat(a.value.manifest.participation==='open','scope_denied');
        const membership=await tx.read('members',who);
        // A cached successful join must not contradict a later revocation.
        requireThat(!membership||membership.value.active,'scope_denied');
        return effect(tx,projectId,actor,'join',idempotencyKey,{},async()=>{
          if(membership)return rowValue(membership);
          const n=await tx.read('meta','members');
          requireThat((n?.value.count??0)<APP_LIMITS.members,'capacity_reached');
          await tx.write('meta','members',{count:(n?.value.count??0)+1},n?.revision??0);
          return rowValue(await tx.write('members',who,{principalId:who,active:true,joinedAt:now()},0));
        });
      });
    },
    async membership(actor,projectId,{principalId,active,expectedRevision,idempotencyKey}){ready();requireThat(typeof active==='boolean','invalid_membership');return storage.transaction(projectId,async tx=>{await manager(actor,projectId,tx.network);requireThat(await tx.network.read('principals',principalId),'not_found');return effect(tx,projectId,actor,active?'membership':'revoke',idempotencyKey,{principalId,active,expectedRevision},async who=>{await app(tx,projectId);const old=await tx.read('members',principalId);if(!old){const n=await tx.read('meta','members');requireThat((n?.value.count??0)<APP_LIMITS.members,'capacity_reached');await tx.write('meta','members',{count:(n?.value.count??0)+1},n?.revision??0);}const r=rowValue(await tx.write('members',principalId,{principalId,active,joinedAt:old?.value.joinedAt??now()},expectedRevision));await event(tx,{type:'member.changed',actorId:who,principalId});return r;});});},
    async records(projectId,{collection,after='',limit=50,authorId,state,parentId,assigneeId}={},actor=null){ready();integer(limit,1,100);const tx=storage.reader(projectId),a=await app(tx,projectId,{publicOnly:!actor});let who='public',own=false;if(actor)({who,own}=await participant(tx,projectId,actor));
      const spec=collection==='tasks'?a.value.manifest.tasks:a.value.manifest.collections.find(c=>c.id===collection);requireThat(spec,'not_found');
      requireThat(spec.visibility==='public'||actor,'scope_denied');requireThat(spec.visibility!=='admins'||own,'scope_denied');if(spec.visibility==='author'&&!own)authorId=who;
      const col=collection==='tasks'?'tasks':'records:'+name(collection),binding=digest({col,authorId:authorId??null,state:state??null,parentId:parentId??null,assigneeId:assigneeId??null});const rows=await tx.list(col,{after:afterCursor(after,projectId,who,binding),limit,authorId,state,parentId,assigneeId});
      return {items:rows.filter(r=>!r.value.hidden).map(rowValue),nextCursor:rows.length===limit?cursor(projectId,who,binding,rows.at(-1).id):null};},
    async writeRecord(actor,projectId,{collection,recordId,data,parentId,expectedRevision=0,idempotencyKey}){ready();return storage.transaction(projectId,async tx=>{const {who,a,own}=await participant(tx,projectId,actor);const spec=a.value.manifest.collections.find(c=>c.id===collection);requireThat(spec,'not_found');requireThat(spec.visibility!=='admins'||own,'scope_denied');schemaValue(spec.schema,data);requireThat(Buffer.byteLength(canonical(data))<=APP_LIMITS.recordBytes,'document_too_large');return effect(tx,projectId,actor,'record:'+collection,idempotencyKey,{recordId:recordId??null,data,parentId:parentId??null,expectedRevision},async()=>{
        const key=recordId??id(),col='records:'+name(collection),old=await tx.read(col,key);if(recordId)requireThat(old&&old.value.authorId===who&&!old.value.hidden,'scope_denied');else{requireThat(expectedRevision===0,'revision_conflict');await countRecord(tx);}
        if(parentId!==undefined){const parent=await tx.read(col,parentId);requireThat(parent&&!parent.value.hidden&&(spec.visibility!=='author'||own||parent.value.authorId===who),'not_found');}
        const result=rowValue(await tx.write(col,key,{id:key,authorId:who,parentId:old?.value.parentId??parentId??null,data:copy(data),version:a.value.version,createdAt:old?.value.createdAt??now(),updatedAt:now(),hidden:false},expectedRevision));await event(tx,{type:old?'record.updated':'record.created',collection,id:key,actorId:who});return result;
      });});},
    async postTask(actor,projectId,{input,idempotencyKey}){ready();return storage.transaction(projectId,async tx=>{const {who,a}=await participant(tx,projectId,actor);const spec=a.value.manifest.tasks;requireThat(spec,'not_found');schemaValue(spec.inputSchema,input);requireThat(Buffer.byteLength(canonical(input))<=APP_LIMITS.recordBytes,'document_too_large');return effect(tx,projectId,actor,'task.post',idempotencyKey,{input},async()=>{await countRecord(tx);const key=id(),result=rowValue(await tx.write('tasks',key,{id:key,authorId:who,input:copy(input),state:'open',generation:0,version:a.value.version,createdAt:now(),updatedAt:now()},0));await event(tx,{type:'task.posted',collection:'tasks',id:key,actorId:who});return result;});});},
    async task(actor,projectId,{taskId,action,generation,output,expectedRevision,idempotencyKey}){ready();requireThat(['claim','deliver','accept','cancel'].includes(action),'invalid_task_action');return storage.transaction(projectId,async tx=>{const {who}=await participant(tx,projectId,actor);return effect(tx,projectId,actor,'task.'+action,idempotencyKey,{taskId,generation:generation??null,output:output??null,expectedRevision},async()=>{
      const row=await tx.read('tasks',taskId);requireThat(row&&!row.value.hidden,'not_found');requireThat(row.revision===expectedRevision,'revision_conflict');const value=copy(row.value),version=await tx.read('versions',String(value.version)),spec=version.value.manifest.tasks;
      if(action==='claim'){requireThat(value.state==='open'||value.state==='claimed'&&value.leaseUntil<=now(),'app_task_busy');value.state='claimed';value.assigneeId=who;value.generation++;value.leaseUntil=now()+spec.leaseSeconds*1000;}
      if(action==='deliver'){requireThat(value.state==='claimed'&&value.assigneeId===who&&value.generation===generation&&value.leaseUntil>now(),'lease_lost');schemaValue(spec.outputSchema,output);requireThat(Buffer.byteLength(canonical(output))<=APP_LIMITS.recordBytes,'document_too_large');value.output=copy(output);value.outputHash=digest(output);value.state='submitted';}
      if(action==='accept'){requireThat(value.authorId===who&&value.state==='submitted','scope_denied');value.state='accepted';}
      if(action==='cancel'){requireThat(value.authorId===who&&['open','claimed','submitted'].includes(value.state),'scope_denied');value.state='cancelled';value.generation++;}
      value.updatedAt=now();const result=rowValue(await tx.write('tasks',taskId,value,expectedRevision));await event(tx,{type:'task.'+action,collection:'tasks',id:taskId,actorId:who});return result;
    });});},
    async events(actor,projectId,{after='',limit=50}={}){ready();integer(limit,1,100);const tx=storage.reader(projectId),{who,a,own}=await participant(tx,projectId,actor);const rows=await tx.list('events',{after:afterCursor(after,projectId,who,'events'),limit}),items=[];
      for(const row of rows){const e=row.value;if(!e.collection){if(own)items.push(copy(e));continue;}const spec=e.collection==='tasks'?a.value.manifest.tasks:a.value.manifest.collections.find(c=>c.id===e.collection),record=await tx.read(e.collection==='tasks'?'tasks':'records:'+e.collection,e.id);if(record&&!record.value.hidden&&(spec?.visibility==='public'||spec?.visibility==='members'||own||spec?.visibility==='author'&&record.value.authorId===who))items.push(copy(e));}
      const end=rows.at(-1)?.id??afterCursor(after,projectId,who,'events');return {items,nextCursor:cursor(projectId,who,'events',end),hasMore:rows.length===limit,delivery:'at-least-once',retention:'retained within finite app capacity'};},
    async moderate(actor,projectId,{collection,recordId,hidden,data,expectedRevision,reason,idempotencyKey}){ready();bounded(reason,500);requireThat(typeof hidden==='boolean','invalid_moderation');return storage.transaction(projectId,async tx=>{const op=await operator(actor,tx.network,'moderate');return effect(tx,projectId,actor,'moderate',idempotencyKey,{collection,recordId,hidden,data:data??null,expectedRevision,reason},async()=>{
      const col=collection==='tasks'?'tasks':'records:'+name(collection),old=await tx.read(col,recordId);requireThat(old,'not_found');const value={...old.value,hidden};
      if(data!==undefined){requireThat(collection!=='tasks','scope_denied');const a=(await tx.read('meta','app')).value,spec=a.manifest.collections.find(c=>c.id===collection);schemaValue(spec.schema,data);requireThat(Buffer.byteLength(canonical(data))<=APP_LIMITS.recordBytes,'document_too_large');value.data=copy(data);}
      value.adminChange={actorId:op,reason,at:now()};const result=rowValue(await tx.write(col,recordId,value,expectedRevision));await audit(tx,op,'moderate',{collection,recordId,reason,before:old,after:result});return result;
    });});},
    async inspect(actor,projectId,{collection,after='',limit=50,reason}){ready();bounded(reason,500);return storage.transaction(projectId,async tx=>{const op=await operator(actor,tx.network);const col=collection==='tasks'?'tasks':collection==='audit'?'audit':'records:'+name(collection),rows=await tx.list(col,{after,limit});await audit(tx,op,'inspect',{collection,reason,after});return {items:rows.map(rowValue),nextCursor:rows.length===limit?rows.at(-1).id:null};});}
  };
  async function audit(tx,actorId,action,data){const key=id();await tx.write('audit',key,{id:key,actorId,action,at:now(),...data},0);}
  async function countRecord(tx){const n=await tx.read('meta','records');requireThat((n?.value.count??0)<APP_LIMITS.records,'capacity_reached');await tx.write('meta','records',{count:(n?.value.count??0)+1},n?.revision??0);}
  return api;
}
