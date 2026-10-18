import {randomUUID} from 'node:crypto';
import {copy,digest,integer,requireThat,shape,text} from '../shared/index.mjs';
import {operatingProject} from '../operating-access/index.mjs';
import {validateManifest,matchManifest} from './manifest.mjs';

const policies='infrastructure-autoscaling',states='infrastructure-autoscale-state';
const key=(projectId,name)=>digest({projectId,autoscaling:name});
const closed=v=>v.terminal||['cancelled','settled'].includes(v.state);
const cleanError=e=>/^[a-z][a-z0-9_]+$/.test(e.code??'')?e.code:'autoscaling_operation_unavailable';

// Each controller uses the ordinary reviewed-image, funding and provider
// lifecycle. The retained actor grants no new authority. Durable task state
// must live outside these disposable replicas before automatic deletion.
export function createAutoscaling({store,identity,admission,quote,request,renew,stop,queueLoad,now=Date.now}){
 async function authorize(actor,projectId,reader=store){
  await identity.authorize(actor,'infrastructure.manage',{projectId},reader);
  requireThat(await operatingProject(reader,projectId),'autoscaling_owned_project_required');
 }
 async function policy(projectId,name,reader=store){
  requireThat(/^[a-z][a-z0-9-]{1,80}$/.test(name??''),'autoscaling_name_invalid');
  const id=key(projectId,name),row=await reader.read(policies,id);requireThat(row,'autoscaling_not_found');return {...row,id};
 }
 async function view(row){
  const {actor,...value}=row.value,state=(await store.read(states,row.value.id))?.value;
  const {lease,...observation}=state??{};
  return {...value,revision:row.revision,state:observation,meaning:'Replica lifecycle, not application completion. Shared operating budget and original provider receipts remain authoritative.'};
 }
 async function configure(actor,projectId,input){
  shape(input,['name','expectedRevision','enabled','profileId','manifest','source','minReplicas','maxReplicas','targetBacklog','scaleUpCooldownSeconds','scaleDownDelaySeconds','leaseSeconds','stateMode']);
  requireThat(/^[a-z][a-z0-9-]{1,80}$/.test(input.name??'')&&typeof input.enabled==='boolean','autoscaling_definition_invalid');
  integer(input.expectedRevision);integer(input.minReplicas,0,100);integer(input.maxReplicas,1,100);requireThat(input.minReplicas<=input.maxReplicas,'autoscaling_replica_range');
  integer(input.targetBacklog,1,1000000);integer(input.scaleUpCooldownSeconds,30,3600);integer(input.scaleDownDelaySeconds,60,86400);integer(input.leaseSeconds,300,86400);
  requireThat(input.stateMode==='external-durable','autoscaling_external_state_required');
  const manifest=validateManifest(input.manifest);requireThat(['http','worker','model'].includes(manifest.mode),'autoscaling_service_required');
  const source=input.source;requireThat(source&&typeof source==='object'&&!Array.isArray(source),'autoscaling_source_invalid');
  if(source.kind==='reported')shape(source,['kind']);
  else {shape(source,['kind','queueId','workId']);requireThat(source.kind==='owned-queue'&&/^res_[a-f0-9]{24}$/.test(source.queueId??'')&&/^nw_[a-z0-9_-]{1,80}$/.test(source.workId??''),'autoscaling_source_invalid');}
  const id=key(projectId,input.name);
  return store.transaction(async tx=>{
   await authorize(actor,projectId,tx);
   const old=await tx.read(policies,id);requireThat((old?.revision??0)===input.expectedRevision,'revision_conflict');
   if(input.enabled){const allowed=await admission(tx,actor,projectId,input.profileId);matchManifest(allowed.profile,manifest);requireThat(input.maxReplicas<=allowed.profile.maxActive&&input.leaseSeconds<=allowed.profile.maxLeaseSeconds,'autoscaling_profile_limit');}
   const state=(await tx.read(states,id))?.value;
   if(state?.members?.length||state?.pending){
    requireThat(old&&digest([old.value.profileId,old.value.manifest,old.value.source])===digest([input.profileId,manifest,source]),'autoscaling_drain_before_template_change');
   }
   const {expectedRevision,...definition}=input;
   const value={...copy(definition),manifest,id,projectId,actor,updatedAt:now()};
   const row=await tx.write(policies,id,value,input.expectedRevision);
   await tx.write('infrastructure-autoscale-versions',id+':'+row.revision,{...value,revision:row.revision},0);
   await tx.event({type:'infrastructure.autoscaling.changed',projectId,autoscalingId:id,revision:row.revision,at:now()});
   return {id,name:input.name,revision:row.revision,enabled:input.enabled};
  });
 }
 async function signal(actor,projectId,name,input){
  shape(input,['sampleId','observedAt','backlog','busy']);text(input.sampleId);requireThat(input.sampleId.length<=128,'autoscaling_sample_invalid');
  integer(input.backlog,0,1000000);integer(input.busy,0,1000000);integer(input.observedAt,now()-300000,now()+30000);
  return store.transaction(async tx=>{
   await authorize(actor,projectId,tx);const p=await policy(projectId,name,tx);requireThat(p.value.source.kind==='reported','autoscaling_source_mismatch');
   const sampleKey=digest({policy:p.id,sampleId:input.sampleId}),prior=await tx.read('infrastructure-autoscale-samples',sampleKey);
   if(prior){requireThat(digest(prior.value.sample)===digest(input),'idempotency_conflict');return prior.value;}
   const previous=await tx.read('infrastructure-autoscale-signal',p.id);
   requireThat(!previous||input.observedAt>previous.value.observedAt,'autoscaling_sample_not_newer');
   const sample={...copy(input),policyRevision:p.revision,receivedAt:now(),enabled:true,authority:'authorized-project-caller'};
   await tx.write('infrastructure-autoscale-signal',p.id,sample,previous?.revision??0);
   const result={sample:copy(input),receivedAt:sample.receivedAt};await tx.write('infrastructure-autoscale-samples',sampleKey,result,0);return result;
  });
 }
 async function reconcile(id){
  const token=randomUUID();
  const claimed=await store.transaction(async tx=>{
   const p=await tx.read(policies,id);if(!p)return null;const row=await tx.read(states,id);
   if(row?.value.lease?.until>now()||row?.value.nextAttemptAt>now())return null;
   const value={sequence:0,members:[],pending:null,lastScaleAt:0,idleSince:null,...row?.value,lease:{token,until:now()+120000}};
   await tx.write(states,id,value,row?.revision??0);return p;
  });
  if(!claimed)return {id,processed:false};
  const p=claimed.value;
  async function fence(tx,{configuration=true}={}){
   const row=await tx.read(states,id);requireThat(row?.value.lease?.token===token&&row.value.lease.until>now(),'autoscaling_lease_lost');
   if(configuration){const latest=await tx.read(policies,id);requireThat(latest?.revision===claimed.revision,'autoscaling_configuration_changed');}
   return row;
  }
  async function save(change){return store.transaction(async tx=>{const row=await fence(tx);const value={...row.value,...change};await tx.write(states,id,value,row.revision);return value;});}
  async function clearPending(){return save({pending:null,nextAttemptAt:0,failures:0,lastScaleAt:now()});}
  try{
   let s=(await store.read(states,id)).value;const members=[];
   let launchFailures=s.configurationRevision===claimed.revision?(s.launchFailures??0):0,lastLaunchFailure=s.lastLaunchFailure??null;
   for(const member of s.members){
    const row=await store.read('infrastructure-resources',member);requireThat(row?.value.autoscalingId===id,'autoscaling_member_missing');
    if(!closed(row.value))members.push({...row,id:member});
    else if(row.value.desired==='running'&&(row.value.error||row.value.leaseUntil>now())){launchFailures++;lastLaunchFailure={resourceId:member,at:now(),error:row.value.error??'replica_ended_before_lease',configurationRevision:claimed.revision};}
   }
   s=await save({members:members.map(r=>r.id),observedAt:now(),configurationRevision:claimed.revision,launchFailures,lastLaunchFailure});
   let allowed=p.enabled,reason=p.enabled?null:'disabled',sample=null;
   if(allowed){try{await admission(store,p.actor,p.projectId,p.profileId,true);}catch(e){allowed=false;reason=cleanError(e);}}
   if(allowed){
    sample=p.source.kind==='owned-queue'?await queueLoad({queueId:p.source.queueId,workId:p.source.workId}):(await store.read('infrastructure-autoscale-signal',id))?.value;
    if(sample?.enabled===false){allowed=false;reason='source_work_inactive';}
   }
   const fresh=!!sample&&(p.source.kind==='owned-queue'||sample.policyRevision===claimed.revision)&&Number.isSafeInteger(sample.observedAt)&&sample.observedAt>=now()-300000&&sample.observedAt<=now()+30000&&Number.isSafeInteger(sample.backlog)&&sample.backlog>=0&&Number.isSafeInteger(sample.busy)&&sample.busy>=0;
   const demand=allowed&&fresh?Math.max(p.minReplicas,Math.min(p.maxReplicas,Math.ceil((sample.backlog+sample.busy)/p.targetBacklog))):0;
   const idle=allowed&&fresh&&sample.busy===0&&sample.backlog===0;
   s=await save({demand,reason:reason??(fresh?null:'load_signal_stale'),sample:sample??null,idleSince:idle?(s.idleSince??now()):null});
   if(s.pending){
    const pending=s.pending;
    if(pending.kind==='renew'&&await store.read('infrastructure-renewals',digest({resourceId:pending.resourceId,renewal:pending.key}))){s=await clearPending();return {id,processed:true,state:'renewed'};}
    // Requests are linked into membership in the same transaction as funding.
    // A stale controller cannot create an unowned extra replica after a stop.
    if(!allowed||!fresh||(pending.kind==='create'&&members.length>=demand)){await clearPending();return {id,processed:true,state:'pending_cancelled_before_reservation'};}
    let q=pending.quoteId?(await store.read('infrastructure-quotes',pending.quoteId))?.value:null;
    if(q?.expiresAt<=now()){s=await save({pending:{...pending,quoteId:null,quoteAttempt:pending.quoteAttempt+1}});q=null;}
    if(!q){
     const current=s.pending;
     q=await quote(p.actor,p.projectId,{profileId:p.profileId,manifest:p.manifest,leaseSeconds:p.leaseSeconds,idempotencyKey:current.key+':quote:'+current.quoteAttempt},true);
     s=await save({pending:{...current,quoteId:q.id}});
    }
    if(pending.kind==='create'){
     await request(p.actor,p.projectId,{quoteId:q.id,idempotencyKey:pending.key},{retained:true,autoscalingId:id,beforeReserve:async tx=>{
      await fence(tx);requireThat((await tx.read(policies,id)).value.enabled,'autoscaling_disabled');
     },onReserved:async(tx,resourceId)=>{
      const row=await fence(tx);const value={...row.value,members:[...new Set([...row.value.members,resourceId])],pending:null,lastScaleAt:now(),nextAttemptAt:0,failures:0};
      await tx.write(states,id,value,row.revision);
     }});
     return {id,processed:true,state:'replica_reserved'};
    }
    const current=await store.read('infrastructure-resources',pending.resourceId);
    if(!current||closed(current.value)||current.value.desired!=='running'){await clearPending();return {id,processed:true,state:'renewal_no_longer_needed'};}
    await renew(p.actor,p.projectId,pending.resourceId,{quoteId:q.id,idempotencyKey:pending.key,expectedRevision:current.revision},{retained:true,beforeReserve:tx=>fence(tx)});
    await clearPending();return {id,processed:true,state:'renewal_reserved'};
   }
   const drain=!allowed||(idle&&s.idleSince+p.scaleDownDelaySeconds*1000<=now());
   const desired=allowed?p.minReplicas:0;
   if(drain&&members.length>desired){
    const member=[...members].reverse().find(r=>r.value.desired==='running');
    if(member)await stop(p.actor,p.projectId,member.id,{expectedRevision:member.revision,remove:true},{beforeStop:async tx=>{const row=await fence(tx);requireThat(row.value.members.includes(member.id),'autoscaling_member_missing');}});
    return {id,processed:true,state:'draining'};
   }
   if(!allowed||!fresh)return {id,processed:true,state:reason??'load_signal_stale'};
   if(members.length<demand&&launchFailures>=3){await save({reason:'repeated_replica_failure_reconfigure_required'});return {id,processed:true,state:'blocked',reason:'repeated_replica_failure_reconfigure_required'};}
   const failureWait=lastLaunchFailure?.configurationRevision===claimed.revision&&lastLaunchFailure.at+Math.min(900000,60000*2**launchFailures)>now();
   if(members.length<demand&&!failureWait&&now()-s.lastScaleAt>=p.scaleUpCooldownSeconds*1000){
    const sequence=s.sequence+1;await save({sequence,pending:{kind:'create',key:'autoscale:'+id.slice(7,39)+':'+sequence,quoteAttempt:0,quoteId:null}});
    return {id,processed:true,state:'scale_up_planned'};
   }
   const candidate=members.find(r=>r.value.desired==='running'&&r.value.state==='running'&&!r.value.renewalPending&&r.value.leaseUntil>now()&&r.value.leaseUntil-now()<Math.min(600000,p.leaseSeconds*500));
   if(candidate&&(demand>0||!idle)){
    const sequence=s.sequence+1;await save({sequence,pending:{kind:'renew',resourceId:candidate.id,key:'autoscale:'+id.slice(7,39)+':'+sequence,quoteAttempt:0,quoteId:null}});
    return {id,processed:true,state:'renewal_planned'};
   }
   return {id,processed:true,state:'stable'};
  }catch(e){
   const row=await store.read(states,id);
   if(row?.value.lease?.token===token)await store.transaction(async tx=>{const r=await fence(tx,{configuration:false});const failures=(r.value.failures??0)+1;await tx.write(states,id,{...r.value,failures,reason:cleanError(e),nextAttemptAt:now()+Math.min(300000,30000*2**Math.min(failures-1,4))},r.revision);}).catch(()=>{});
   return {id,processed:true,state:'blocked',reason:cleanError(e)};
  }finally{
   await store.transaction(async tx=>{const row=await tx.read(states,id);if(row?.value.lease?.token===token)await tx.write(states,id,{...row.value,lease:null},row.revision);});
  }
 }
 return {
  configure,signal,
  async get(actor,projectId,name){await authorize(actor,projectId);return view(await policy(projectId,name));},
  async list(actor,projectId,{after='',limit=50}={}){await authorize(actor,projectId);integer(limit,1,100);const rows=await store.list(policies,{projectId,after,limit});return {items:await Promise.all(rows.map(view)),nextCursor:rows.length===limit?rows.at(-1).id:null};},
  async tick(){
   const cursor=await store.read('controller-cursors','autoscaling-page');let rows=await store.list(policies,{after:cursor?.value.after??'',limit:1});
   if(!rows.length)rows=await store.list(policies,{limit:1});const results=[];for(const row of rows)results.push(await reconcile(row.id));
   await store.transaction(async tx=>{const old=await tx.read('controller-cursors','autoscaling-page');await tx.write('controller-cursors','autoscaling-page',{after:rows.at(-1)?.id??''},old?.revision??0);});return {results};
  }
 };
}
