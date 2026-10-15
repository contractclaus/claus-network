import {randomBytes} from 'node:crypto';
import {copy,digest,integer,requireThat,sourceText,text} from '../shared/index.mjs';
import {RUNTIME_ACTIONS,bindAction,recoveryFor} from './action-broker.mjs';
export {RUNTIME_ACTIONS} from './action-broker.mjs';
const farFuture=253402300799000;
const bounded=value=>{const raw=JSON.stringify(value);requireThat(raw!==undefined&&Buffer.byteLength(raw)<=12000,'runtime_state_too_large');return copy(value);};
const key=(projectId,runtimeId)=>{text(projectId);requireThat(/^[a-z][a-z0-9-]{0,39}$/.test(runtimeId),'invalid_runtime_id');return projectId+':'+runtimeId;};
const view=row=>{const {actor,lease,...value}=row.value;return {...value,revision:row.revision};};
export function createRuntimes({store,identity,workers,execute,route,readWeb,now=()=>Date.now()}){
 async function auth(actor,projectId,reader=store){return identity.owner(actor,projectId,reader);}
 async function update(id,token,changes){return store.transaction(async tx=>{const r=await tx.read('project-runtimes',id);requireThat(r?.value.lease?.token===token,'lease_lost');const value={...r.value,...changes,lease:null,updatedAt:now()};if(!value.pending&&value.cycle>=value.maxCycles){value.enabled=false;value.state='completed';value.completionReason='cycle_limit';}if(!r.value.enabled){value.enabled=false;if(r.value.state==='paused')value.state='paused';}return tx.write('project-runtimes',id,value,r.revision);});}
 async function machineActor(tx,id,projectId,ownerId,previous){
  if(previous&&await identity.allowed(previous,'worker.run',{projectId},tx))return previous;
  // Only explicit owner configuration/reconciliation can renew this fixed grant.
  // It never changes project, principal, budgets, worker code or pending effects.
  const actor=digest({runtime:id,nonce:randomBytes(32).toString('hex')}),principalId='runtime_'+digest({id}).slice(7),mandateId='rtm_'+actor.slice(7);
  const scopes=['web.read','worker.run','worker.read','worker.cancel','inference.read','inference.submit','app.use'];
  if(!await tx.read('principals',principalId))await tx.write('principals',principalId,{id:principalId,kind:'agent',projectId,createdAt:now()},0);
  await tx.write('mandates',mandateId,{id:mandateId,projectId,ownerId,principalId,scopes,expiresAt:farFuture,revokedAt:null,createdAt:now(),runtimeId:id},0);
  await tx.write('credentials',actor,{id:actor,kind:'delegate',projectId,principalId,mandateId,scopes,expiresAt:farFuture,revokedAt:null,createdAt:now()},0);
  return actor;
 }
 const api={
  async resourcePolicy(actor,{operators,expectedRevision}){
   requireThat(Array.isArray(operators)&&operators.length<=16&&new Set(operators).size===operators.length,'invalid_runtime_operators');integer(expectedRevision);
   return store.transaction(async tx=>{const who=await identity.credential(actor,tx),principal=(await tx.read('principals',who.principalId))?.value,authority=(await tx.read('network','authority'))?.value;requireThat(who.kind==='owner'&&principal?.chainId===1&&principal.address===authority?.ownerAddress,'scope_denied');for(const id of operators)requireThat(await tx.read('principals',text(id)),'not_found');const saved=await tx.write('runtime-control','resource-policy',{operators},expectedRevision);return{operators,revision:saved.revision};});
  },
  async resources(actor,projectId){
   const who=await identity.credential(actor),operators=(await store.read('runtime-control','resource-policy'))?.value.operators??[],project=(await store.read('projects',projectId))?.value;
   requireThat(who.kind==='owner'&&(operators.includes(who.principalId)||project?.ownerId===who.principalId),'scope_denied');const r=await store.read('project-worker-resources',projectId);return{projectId,projectDaily:r?.value.projectDaily??20,active:r?.value.active??1,revision:r?.revision??0,reason:r?.value.reason??null,globalDaily:100,globalActive:4,globalTotal:null,commandSeconds:30,vmSeconds:60};
  },
  async setResources(actor,projectId,{projectDaily,active,reason,expectedRevision}){
   integer(projectDaily,0,100);integer(active,1,4);sourceText(reason,1000);integer(expectedRevision);
   return store.transaction(async tx=>{const who=await identity.credential(actor,tx),operators=(await tx.read('runtime-control','resource-policy'))?.value.operators??[];requireThat(who.kind==='owner'&&operators.includes(who.principalId),'scope_denied');const p=(await tx.read('projects',projectId))?.value;requireThat(p&&!p.archivedAt&&!p.transfer,'project_unavailable');const saved=await tx.write('project-worker-resources',projectId,{projectId,projectDaily,active,reason,issuer:who.principalId,updatedAt:now()},expectedRevision);await tx.event({type:'runtime.resources_changed',projectId,projectDaily,active,at:now()});return{...saved.value,revision:saved.revision};});
  },
  async discovery(){const w=await workers.discovery();return {enabled:w.enabled,profile:'durable-project-worker/1',memory:'private-checkpoint',network:'listed-network-actions',broker:{profile:'fixed-authorized-actions/1',workerCredentials:false,arbitrarySql:false,arbitrarySignatures:false,recovery:'same-original-request',maximumAutomaticRetries:3},actions:RUNTIME_ACTIONS,workerLimits:w.limits,maxPerProject:5,minimumIntervalSeconds:60,unknownActions:'hold-original-operation',resourceAssignment:true,web:{scope:'web.read',method:'GET',protocol:'HTTPS',maximumCharacters:4000,perProjectDaily:100,privateDestinations:false}};},
  async configure(actor,projectId,input){
   const {runtimeId,workerId,workerRevision,intervalSeconds,maxCycles,initialState,enabled,expectedRevision}=input;
   key(projectId,runtimeId);integer(workerRevision,1);integer(intervalSeconds,60,604800);integer(maxCycles,1,1000000);integer(expectedRevision);requireThat(typeof enabled==='boolean','invalid_runtime');bounded(initialState);
   const definition=await workers.get(actor,projectId,workerId);requireThat(definition.revision===workerRevision&&definition.enabled,'worker_unavailable');
   return store.transaction(async tx=>{
    const {who}=await auth(actor,projectId,tx),id=key(projectId,runtimeId),old=await tx.read('project-runtimes',id);requireThat((old?.revision??0)===expectedRevision,'revision_conflict');
    requireThat(!old?.value.pending&&!old?.value.lease,'runtime_busy');
    const all=await tx.list('project-runtimes',{prefix:projectId+':',limit:6});requireThat(old||all.length<5,'capacity_reached');
    if(enabled)await identity.authorize(actor,'worker.run',{projectId},tx);
    const serviceActor=await machineActor(tx,id,projectId,who.principalId,old?.value.ownerId===who.principalId?old?.value.actor:null);
    const exhausted=(old?.value.cycle??0)>=maxCycles;
    const value={projectId,runtimeId,workerId,workerRevision,intervalSeconds,maxCycles,enabled,ownerId:who.principalId,actor:serviceActor,
     memory:old?.value.memory??copy(initialState),observation:old?.value.observation??null,cycle:old?.value.cycle??0,pending:null,lease:null,nextAt:now(),state:enabled?(exhausted?'completed':'ready'):'paused',updatedAt:now(),...(exhausted?{enabled:false,completionReason:'cycle_limit'}:{})};
    const saved=await tx.write('project-runtimes',id,value,expectedRevision);await tx.event({type:'runtime.configured',projectId,runtimeId,enabled:value.enabled,at:now()});return view(saved);
   });
  },
  async webRead(actor,projectId,{url}){
   await identity.authorize(actor,'web.read',{projectId});requireThat(typeof url==='string'&&url.length<=2048,'invalid_web_url');
   await store.transaction(async tx=>{await identity.authorize(actor,'web.read',{projectId},tx);const day=Math.floor(now()/86400000),id=projectId+':'+day,r=await tx.read('project-web-usage',id);requireThat((r?.value.count??0)<100,'web_daily_limit');await tx.write('project-web-usage',id,{projectId,day,count:(r?.value.count??0)+1},r?.revision??0);});
   requireThat(typeof readWeb==='function','web_unavailable');return readWeb(url);
  },
  async get(actor,projectId,runtimeId){await auth(actor,projectId);const r=await store.read('project-runtimes',key(projectId,runtimeId));requireThat(r,'not_found');return view(r);},
  async list(actor,projectId){await auth(actor,projectId);return {items:(await store.list('project-runtimes',{prefix:projectId+':',limit:10})).map(view)};},
  async checkpoint(actor,projectId,runtimeId,{memory,expectedRevision}){
   bounded(memory);integer(expectedRevision);return store.transaction(async tx=>{await auth(actor,projectId,tx);const id=key(projectId,runtimeId),r=await tx.read('project-runtimes',id);requireThat(r?.revision===expectedRevision,'revision_conflict');requireThat(!r.value.pending&&!r.value.lease,'runtime_busy');return view(await tx.write('project-runtimes',id,{...r.value,memory:copy(memory),observation:null,updatedAt:now()},r.revision));});
  },
  async reconcile(actor,projectId,runtimeId,{expectedRevision}){
   integer(expectedRevision,1);
   return store.transaction(async tx=>{const {who}=await auth(actor,projectId,tx);const id=key(projectId,runtimeId),r=await tx.read('project-runtimes',id);requireThat(r?.revision===expectedRevision,'revision_conflict');requireThat(r.value.ownerId===who.principalId,'scope_denied');requireThat(!r.value.lease||r.value.lease.until<=now(),'runtime_busy');const pending=r.value.pending;
    const resume=async changes=>{
     await identity.authorize(actor,'worker.run',{projectId},tx);
     requireThat(r.value.cycle<r.value.maxCycles,'runtime_cycle_limit');
     const definition=await tx.read('project-workers',projectId+':'+r.value.workerId);
     requireThat(definition?.value.enabled&&definition.revision===r.value.workerRevision,'worker_unavailable');
     const serviceActor=await machineActor(tx,id,projectId,who.principalId,r.value.actor);
     return tx.write('project-runtimes',id,{...r.value,...changes,actor:serviceActor,enabled:true,lease:null,state:'ready',nextAt:now(),updatedAt:now()},r.revision);
    };
    if(pending?.kind==='action'&&pending.operation==='inference_submit'){
     // Only the original idempotent submission can resume. No replacement key,
     // profile or input is accepted from the caller.
     requireThat(pending.input.projectId===projectId&&pending.idempotent===true&&pending.input.idempotencyKey==='runtime:'+digest({id,cycle:r.value.cycle}).slice(7),'runtime_original_not_resolved');
     const requestId=digest({projectId,inference:pending.input.idempotencyKey}),original=await tx.read('inference-requests',requestId);
     const {projectId:_,idempotencyKey,...request}=pending.input;
     requireThat(original?original.value.requestHash===digest(request):r.value.observation?.error==='inference_quote_unverified','runtime_original_not_resolved');
     const saved=await resume({});
     await tx.event({type:'runtime.reconciled',projectId,runtimeId,requestId,at:now()});return view(saved);
    }
    if(pending?.kind==='action'){
     const rebound=bindAction(pending,{route,projectId,cycleKey:'runtime:'+digest({id,cycle:r.value.cycle}).slice(7)});
     requireThat(digest(rebound.input)===digest(pending.input),'runtime_original_not_resolved');
     const recovery=pending.sending===false?{allowed:true,pending}:await recoveryFor(r.value,{id,route,reader:tx,now:now()});requireThat(recovery.allowed,'runtime_original_not_resolved');
     const saved=await resume({pending:recovery.pending});
     await tx.event({type:'runtime.reconciled',projectId,runtimeId,operation:pending.operation,originalKey:pending.input.idempotencyKey??null,at:now()});return view(saved);
    }
    requireThat(pending?.kind==='worker','runtime_original_action_required');
    const cycleKey='runtime:'+digest({id,cycle:r.value.cycle}).slice(7),run=await tx.read('worker-runs',pending.id);
    requireThat(pending.id===digest({projectId,idempotencyKey:cycleKey})&&run?.value.projectId===projectId&&run.value.workerId===r.value.workerId&&run.value.definitionRevision===r.value.workerRevision,'runtime_original_not_resolved');
    if(run.value.state==='completed'){
     requireThat(typeof run.value.resultJson==='string','runtime_original_not_resolved');
     const output=JSON.parse(run.value.resultJson);requireThat(output&&Object.hasOwn(output,'state'),'runtime_output_requires_state');bounded(output.state);
     if(output.action)bindAction(output.action,{route,projectId,cycleKey});
     const saved=await resume({});
     await tx.event({type:'runtime.reconciled',projectId,runtimeId,workerRunId:pending.id,resume:'original-completed-worker',at:now()});return view(saved);
    }
    requireThat(['failed','cancelled'].includes(run.value.state),'runtime_original_not_resolved');
    // Advance the unsuccessful cycle only after a definite no-result outcome.
    const saved=await tx.write('project-runtimes',id,{...r.value,enabled:false,pending:null,lease:null,cycle:r.value.cycle+1,state:'paused',observation:{workerRunId:pending.id,state:run.value.state,error:run.value.error??null},updatedAt:now()},r.revision);await tx.event({type:'runtime.reconciled',projectId,runtimeId,workerRunId:pending.id,at:now()});return view(saved);});
  },
  async stop(actor,projectId,runtimeId,{expectedRevision}){
   integer(expectedRevision);return store.transaction(async tx=>{await auth(actor,projectId,tx);const id=key(projectId,runtimeId),r=await tx.read('project-runtimes',id);requireThat(r?.revision===expectedRevision,'revision_conflict');
    const c=await tx.read('credentials',r.value.actor);if(c&&!c.value.revokedAt)await tx.write('credentials',r.value.actor,{...c.value,revokedAt:now()},c.revision);
    const saved=await tx.write('project-runtimes',id,{...r.value,enabled:false,state:'paused',updatedAt:now()},r.revision);await tx.event({type:'runtime.stopped',projectId,runtimeId,at:now()});return view(saved);});
  },
  async tick(){
   // Cursor bounds the scan; each active runtime keeps its own durable operation.
   const cursor=(await store.read('runtime-control','cursor'))?.value.after??'';
   const rows=await store.list('project-runtimes',{after:cursor,limit:20});let processed=0;
   let visited='',exhausted=true;
   for(const row of rows){
    if(processed>=4){exhausted=false;break;}visited=row.id;
    const token=randomBytes(16).toString('hex');
    const work=await store.transaction(async tx=>{const r=await tx.read('project-runtimes',row.id);if(!r?.value.enabled||r.value.nextAt>now()||r.value.lease?.until>now()||r.value.state==='unknown')return null;
     if(r.value.cycle>=r.value.maxCycles){if(!r.value.pending)await tx.write('project-runtimes',row.id,{...r.value,enabled:false,state:'completed',completionReason:'cycle_limit',lease:null,updatedAt:now()},r.revision);return null;}
     const project=(await tx.read('projects',r.value.projectId))?.value;if(!project||project.ownerId!==r.value.ownerId||project.archivedAt||project.transfer)return null;
     const next={...r.value,lease:{token,until:now()+60000}};await tx.write('project-runtimes',row.id,next,r.revision);return next;});
    if(!work)continue;processed++;
    try{
     await identity.authorize(work.actor,'worker.run',{projectId:work.projectId});
     const cycleKey='runtime:'+digest({id:row.id,cycle:work.cycle}).slice(7);
     if(!work.pending){
      // run() is itself idempotent across an acknowledgement loss.
      const run=await workers.run(work.actor,work.projectId,{workerId:work.workerId,expectedRevision:work.workerRevision,input:{state:work.memory,observation:work.observation,cycle:work.cycle},idempotencyKey:cycleKey});
      await update(row.id,token,{pending:{kind:'worker',id:run.id},state:'working',nextAt:now()+60000});continue;
     }
     if(work.pending.kind==='worker'){
      const run=await workers.runGet(work.actor,work.projectId,work.pending.id);
      if(!['completed','failed','cancelled','unknown'].includes(run.state)){await update(row.id,token,{nextAt:now()+60000});continue;}
      if(run.state!=='completed'){await update(row.id,token,{state:run.state==='unknown'?'unknown':'blocked',enabled:false,observation:{workerRunId:run.id,state:run.state,error:run.error??null}});continue;}
      const output=run.result;requireThat(output&&Object.hasOwn(output,'state'),'runtime_output_requires_state');bounded(output.state);
      const action=output.action??null;
      if(action){
       const pending=bindAction(action,{route,projectId:work.projectId,cycleKey});
       await update(row.id,token,{memory:output.state,pending,state:'working',nextAt:now()});
      }else await update(row.id,token,{memory:output.state,observation:null,pending:null,cycle:work.cycle+1,enabled:output.done===true?false:work.enabled,state:output.done===true?'completed':'ready',nextAt:now()+work.intervalSeconds*1000});
      continue;
     }
     const action=work.pending;
     if(action.sending&&!action.idempotent){await update(row.id,token,{state:'unknown',enabled:false});continue;}
     await store.transaction(async tx=>{const r=await tx.read('project-runtimes',row.id);requireThat(r?.value.lease?.token===token&&r.value.enabled,'lease_lost');await tx.write('project-runtimes',row.id,{...r.value,pending:{...action,sending:true}},r.revision);});
     const result=await execute(action.operation,action.input,work.actor);
     let observation;try{observation=bounded({operation:action.operation,result});}catch{observation={operation:action.operation,error:'result_exceeds_checkpoint_limit'};}
     await update(row.id,token,{observation,pending:null,cycle:work.cycle+1,state:'ready',nextAt:now()+work.intervalSeconds*1000});
    }catch(e){
     if(e.code==='lease_lost')continue;
     const r=await store.read('project-runtimes',row.id),sent=r?.value.pending?.sending;
     const boundedError=/^[a-z_]{1,80}$/.test(e.code??'')?e.code:'runtime_outcome_unknown';
     if(!sent&&['worker_project_busy','worker_capacity_reached','worker_daily_limit','rate_limited'].includes(e.code)){
      await update(row.id,token,{state:'waiting',nextAt:e.code==='worker_daily_limit'?(Math.floor(now()/86400000)+1)*86400000:now()+60000});continue;
     }
     // Recover only the original safely repeatable API operation. Explicit stop,
     // revocation, ownership change and every unknown financial result remain held.
     const retryable=['runtime_outcome_unknown','network_failure','fetch_failed','request_timeout','storage_unavailable','temporarily_unavailable','rate_limited'];
     if(sent&&r?.value.enabled&&retryable.includes(boundedError)){
      const recovery=await recoveryFor(r.value,{id:row.id,route,reader:store,now:now()}).catch(()=>({allowed:false}));
      if(recovery.allowed){await update(row.id,token,{pending:recovery.pending,state:'waiting',nextAt:recovery.nextAt,observation:{error:boundedError,recovery:recovery.reason}}).catch(()=>{});continue;}
     }
     await update(row.id,token,{state:sent?'unknown':'blocked',enabled:false,observation:{error:boundedError}}).catch(()=>{});
    }
   }
   await store.transaction(async tx=>{const r=await tx.read('runtime-control','cursor');await tx.write('runtime-control','cursor',{after:!exhausted||rows.length===20?visited:''},r?.revision??0);});
   return {processed};
  }
 };
 return api;
}
