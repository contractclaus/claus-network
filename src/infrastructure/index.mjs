import {createResourceControl} from './control.mjs';
import {randomUUID} from 'node:crypto';
import {amount,copy,digest,integer,requireThat,text} from '../shared/index.mjs';
import {reserve,settleReservation} from '../billing/index.mjs';
import {INFRASTRUCTURE_VERSION,validateManifest,validateProfile,matchManifest} from './manifest.mjs';
import {createOciBuildPlan} from './build-plan.mjs';

const grantKey=(projectId,profileId)=>digest({projectId,profileId});
const maximum=v=>v.reservedMaximum??v.quote.maximum;
const done=new Set(['cancelled','settled']);
export function createInfrastructure({store,identity,projects,now=()=>Date.now(),ports={},enabled=false}) {
  const control=createResourceControl({store,identity,now});
  async function auth(actor,projectId,action='infrastructure.read',reader=store){await identity.authorize(actor,action,{projectId},reader);}
  async function owner(actor,reader){
    const c=await identity.credential(actor,reader),p=(await reader.read('principals',c.principalId))?.value,a=(await reader.read('network','authority'))?.value;
    requireThat(c.kind==='owner'&&p?.chainId===1&&p.address===a?.ownerAddress,'scope_denied');
  }
  async function admission(reader,actor,projectId,profileId){
    await auth(actor,projectId,'infrastructure.manage',reader);
    requireThat(enabled,'infrastructure_not_enabled');
    const row=await reader.read('infrastructure-profiles',profileId),profile=validateProfile(row?.value);
    requireThat(profile.enabled&&await control.active(reader,profileId),'infrastructure_profile_disabled');
    const grant=await reader.read('infrastructure-grants',grantKey(projectId,profileId));
    requireThat(grant?.value.enabled&&grant.value.expiresAt>now(),'infrastructure_allowance_unavailable');
    return {profile,profileRevision:row.revision,grant};
  }
  async function resource(reader,projectId,id){const r=await reader.read('infrastructure-resources',text(id));requireThat(r?.value.projectId===projectId,'not_found');return r;}
  function visible(r){
    const v=r.value;
    return {id:v.id,projectId:v.projectId,profileId:v.profile.id,manifest:v.manifest,revision:r.revision,
      state:v.state,desired:v.desired,createdAt:v.createdAt,leaseUntil:v.leaseUntil,providerLeaseUntil:v.providerLeaseUntil??null,renewalPending:v.renewalPending===true,terminal:v.terminal===true,storageRetained:v.storageRetained??null,nextAttemptAt:v.nextAttemptAt??null,
      providerResourceId:v.providerResourceId??null,endpoint:v.endpoint??null,
      cost:{asset:v.profile.asset,maximum:maximum(v),actual:v.actual??null,state:v.billing,observation:v.costObservation??null},
      error:v.error??null,errorDetails:v.errorDetails??null,requiresReconciliation:v.state==='unknown',operationId:v.operationId};
  }
  async function adjustGrant(tx,v,reserved,spent){
    const id=grantKey(v.projectId,v.profile.id),g=await tx.read('infrastructure-grants',id);requireThat(g,'infrastructure_allowance_missing');
    const next={...g.value,reserved:(amount(g.value.reserved)+reserved).toString(),spent:(amount(g.value.spent)+spent).toString()};
    amount(next.reserved);amount(next.spent);await tx.write('infrastructure-grants',id,next,g.revision);
  }
  async function settle(tx,r,receipt){
    const v=r.value;
    requireThat(v.billing==='reserved'&&receipt.resourceId===v.id&&receipt.accountId===v.profile.accountId&&receipt.asset===v.profile.asset&&receipt.final===true,'infrastructure_receipt_mismatch');
    requireThat(amount(receipt.actual)<=amount(maximum(v)),'cost_exceeds_reservation');
    const receiptId=text(receipt.id),old=await tx.read('infrastructure-receipts',receiptId);
    requireThat(!old||old.value.resourceId===v.id,'infrastructure_receipt_reused');
    await settleReservation(tx,v.profile.fundingAccount,v.profile.asset,maximum(v),receipt.actual);
    await adjustGrant(tx,v,-amount(maximum(v)),amount(receipt.actual));
    if(!old)await tx.write('infrastructure-receipts',receiptId,{resourceId:v.id,receipt:copy(receipt)},0);
    return {billing:'settled',actual:receipt.actual,state:'settled',receiptId};
  }
  const api={
    async discovery(){return {profile:INFRASTRUCTURE_VERSION,enabled,providerExecution:enabled&&['quote','verifyRelease','create','inspect','stop','logs','verifyReceipt'].every(name=>typeof ports[name]==='function'),reconciliation:typeof ports.inspect==='function'&&typeof ports.stop==='function',sourcePlans:true,buildExecution:false,renewableLeases:typeof ports.extend==='function',independentProviderGuard:true,readiness:'/v1/projects/{projectId}/infrastructure/readiness',funding:'explicit-project-allowance',images:'immutable-reviewed-digest',unknownOutcomes:'original-resource-reconciliation',updates:'stop-settle-then-create-new-release',resources:'/v1/projects/{projectId}/infrastructure'};},
    async readiness(actor,projectId){await auth(actor,projectId);return typeof ports.readiness==='function'?await ports.readiness():{enabled:false,configured:false,profiles:[]};},
    async buildPlan(actor,projectId,{snapshotId,dockerfile}){
      await auth(actor,projectId,'build.compile');
      const files=await projects.files(actor,projectId,snapshotId);
      const {source,...plan}=createOciBuildPlan({projectId,snapshotId,files,dockerfile});
      return plan;
    },
    control,
    async setProfile(actor,{profile,expectedRevision}){
      const p=validateProfile(profile);integer(expectedRevision);
      return store.transaction(async tx=>{await owner(actor,tx);const old=await tx.read('infrastructure-profiles',p.id);
        if(old){const {enabled:a,...before}=old.value,{enabled:b,...after}=p;requireThat(digest(before)===digest(after),'infrastructure_profile_immutable');}
        const r=await tx.write('infrastructure-profiles',p.id,p,expectedRevision);return {id:p.id,revision:r.revision,enabled:p.enabled};});
    },
    async setGrant(actor,projectId,{profileId,enabled:active,expiresAt,limit,expectedRevision}){
      text(profileId);integer(expectedRevision);integer(expiresAt,now()+1);amount(limit);requireThat(typeof active==='boolean','invalid_allowance');
      return store.transaction(async tx=>{await owner(actor,tx);requireThat(!await tx.read('infrastructure-controls',profileId),'infrastructure_controlled_grant_required');requireThat(await tx.read('projects',projectId),'not_found');requireThat(await tx.read('infrastructure-profiles',profileId),'not_found');
        const id=grantKey(projectId,profileId),old=await tx.read('infrastructure-grants',id),reserved=old?.value.reserved??'0',spent=old?.value.spent??'0';
        requireThat(amount(limit)>=amount(reserved)+amount(spent),'allowance_below_obligations');
        const r=await tx.write('infrastructure-grants',id,{projectId,profileId,enabled:active,expiresAt,limit,reserved,spent},expectedRevision);return {...r.value,revision:r.revision};});
    },
    async list(actor,projectId,{after='',limit=50}={}){await auth(actor,projectId);integer(limit,1,100);const rows=await store.list('infrastructure-resources',{projectId,after,limit});return {items:rows.map(visible),nextCursor:rows.length===limit?rows.at(-1).id:null};},
    async get(actor,projectId,id){await auth(actor,projectId);return visible(await resource(store,projectId,id));},
    async profiles(actor,projectId){await auth(actor,projectId);const rows=await store.list('infrastructure-grants',{projectId,limit:100});return {items:await Promise.all(rows.map(async r=>{const p=await store.read('infrastructure-profiles',r.value.profileId);return {profile:p?.value??null,allowance:{...r.value,revision:r.revision}};}))};},
    async quote(actor,projectId,{profileId,manifest,leaseSeconds,idempotencyKey}){
      const m=validateManifest(manifest);text(idempotencyKey);const {profile}=await admission(store,actor,projectId,profileId);integer(leaseSeconds,60,profile.maxLeaseSeconds);matchManifest(profile,m);
      const request={projectId,profile,manifest:m,leaseSeconds},requestHash=digest(request),id=digest({projectId,quote:idempotencyKey});
      const old=await store.read('infrastructure-quotes',id);if(old){requireThat(old.value.requestHash===requestHash,'idempotency_conflict');return copy(old.value);}
      requireThat(typeof ports.quote==='function'&&typeof ports.verifyRelease==='function','infrastructure_provider_unavailable');
      requireThat(await ports.verifyRelease({projectId,manifest:m})===true,'infrastructure_release_not_approved');
      const result=await ports.quote({...request,requestHash});
      requireThat(result.requestHash===requestHash&&result.accountId===profile.accountId&&result.asset===profile.asset&&result.expiresAt>now()&&result.expiresAt<=now()+300000&&result.totalLifecycle===true,'infrastructure_quote_invalid');
      requireThat(amount(result.maximum)>0n&&amount(result.maximum)<=amount(profile.maxPerLease),'infrastructure_quote_over_limit');
      const q={id,requestHash,projectId,profile,manifest:m,leaseSeconds,maximum:result.maximum,expiresAt:result.expiresAt,providerQuoteId:text(result.id),createdAt:now()};
      return store.transaction(async tx=>{await admission(tx,actor,projectId,profileId);const r=await tx.read('infrastructure-quotes',id);if(r){requireThat(r.value.requestHash===requestHash,'idempotency_conflict');return r.value;}await tx.write('infrastructure-quotes',id,q,0);return q;});
    },
    async request(actor,projectId,{quoteId,idempotencyKey}){
      text(quoteId);text(idempotencyKey);const id=digest({projectId,infrastructure:idempotencyKey});
      return store.transaction(async tx=>{await auth(actor,projectId,'infrastructure.manage',tx);const old=await tx.read('infrastructure-resources',id);
        if(old){requireThat(old.value.quote.id===quoteId,'idempotency_conflict');return visible(old);}
        const q=(await tx.read('infrastructure-quotes',quoteId))?.value;requireThat(q?.projectId===projectId&&q.expiresAt>now(),'infrastructure_quote_expired');
        const {profile,grant}=await admission(tx,actor,projectId,q.profile.id);requireThat(digest(profile)===digest(q.profile),'infrastructure_profile_changed');
        requireThat(!await tx.read('infrastructure-quote-use',quoteId),'infrastructure_quote_already_used');
        requireThat(amount(grant.value.limit)>=amount(grant.value.reserved)+amount(grant.value.spent)+amount(q.maximum),'infrastructure_allowance_exhausted');
        const capacityId=grantKey(projectId,profile.id),capacity=await tx.read('infrastructure-capacity',capacityId),active=capacity?.value.active??[];
        requireThat(active.length<profile.maxActive,'infrastructure_capacity_reached');
        await control.checkSpend(tx,profile.id,q.maximum);
        await reserve(tx,profile.fundingAccount,profile.asset,q.maximum);
        const globalId='profile:'+profile.id,global=await tx.read('infrastructure-capacity',globalId),globalActive=global?.value.active??[];
        requireThat(globalActive.length<profile.maxActive,'infrastructure_capacity_reached');
        await tx.write('infrastructure-capacity',globalId,{active:[...globalActive,id]},global?.revision??0);
        const value={id,projectId,actor,profile,manifest:q.manifest,quote:q,createdAt:now(),leaseUntil:now()+q.leaseSeconds*1000,state:'queued',desired:'running',billing:'reserved',reservedMaximum:q.maximum,extensions:[],operationId:id,attempted:false};
        await adjustGrant(tx,value,amount(q.maximum),0n);
        await tx.write('infrastructure-capacity',capacityId,{projectId,active:[...active,id]},capacity?.revision??0);
        await tx.write('infrastructure-quote-use',quoteId,{resourceId:id},0);
        const r=await tx.write('infrastructure-resources',id,value,0);await tx.event({type:'infrastructure.requested',projectId,resourceId:id,at:now()});return visible(r);
      });
    },
    async renew(actor,projectId,id,{quoteId,idempotencyKey,expectedRevision}){
      text(idempotencyKey);text(quoteId);integer(expectedRevision);
      const renewalId=digest({resourceId:id,renewal:idempotencyKey});
      return store.transaction(async tx=>{
        await auth(actor,projectId,'infrastructure.manage',tx);
        const r=await resource(tx,projectId,id),v=r.value,prior=await tx.read('infrastructure-renewals',renewalId);
        if(prior){requireThat(prior.value.quoteId===quoteId,'idempotency_conflict');return visible(r);}
        requireThat(r.revision===expectedRevision,'revision_conflict');
        requireThat(!v.controllerLease||v.controllerLease.until<=now(),'resource_busy');
        requireThat(v.state==='running'&&v.desired==='running'&&!v.renewalPending&&v.leaseUntil>now(),'resource_not_running');
        requireThat(typeof ports.extend==='function','infrastructure_provider_unavailable');
        const q=(await tx.read('infrastructure-quotes',quoteId))?.value;
        requireThat(q?.projectId===projectId&&q.expiresAt>now(),'infrastructure_quote_expired');
        requireThat(digest(q.manifest)===digest(v.manifest)&&digest(q.profile)===digest(v.profile),'infrastructure_renewal_mismatch');
        requireThat(!await tx.read('infrastructure-quote-use',quoteId),'infrastructure_quote_already_used');
        const {profile,grant}=await admission(tx,actor,projectId,v.profile.id);
        requireThat(v.leaseUntil+q.leaseSeconds*1000<=now()+profile.maxLeaseSeconds*1000,'infrastructure_lease_too_long');
        requireThat(amount(grant.value.limit)>=amount(grant.value.reserved)+amount(grant.value.spent)+amount(q.maximum),'infrastructure_allowance_exhausted');
        await control.checkSpend(tx,profile.id,q.maximum);
        await reserve(tx,profile.fundingAccount,profile.asset,q.maximum);await adjustGrant(tx,v,amount(q.maximum),0n);
        const extension={id:renewalId,sequence:(v.extensions?.at(-1)?.sequence??0)+1,previousUntil:v.leaseUntil,quote:q};
        await tx.write('infrastructure-renewals',renewalId,{resourceId:id,quoteId,extension},0);
        await tx.write('infrastructure-quote-use',quoteId,{resourceId:id,renewalId},0);
        return visible(await tx.write('infrastructure-resources',id,{...v,extensions:[extension],leaseUntil:v.leaseUntil+q.leaseSeconds*1000,reservedMaximum:(amount(maximum(v))+amount(q.maximum)).toString(),renewalPending:true,nextAttemptAt:null},r.revision));
      });
    },
    async stop(actor,projectId,id,{expectedRevision,remove=false}){
      integer(expectedRevision);requireThat(typeof remove==='boolean','invalid_stop');
      return store.transaction(async tx=>{await auth(actor,projectId,'infrastructure.stop',tx);const r=await resource(tx,projectId,id);requireThat(r.revision===expectedRevision,'revision_conflict');
        if(done.has(r.value.state))return visible(r);
        return visible(await tx.write('infrastructure-resources',id,{...r.value,desired:remove?'deleted':'stopped',stopRequestedAt:now(),nextAttemptAt:null},r.revision));});
    },
    async logs(actor,projectId,id){await auth(actor,projectId);const r=await resource(store,projectId,id);requireThat(typeof ports.logs==='function','infrastructure_provider_unavailable');const value=await ports.logs(r.value);requireThat(typeof value==='string'&&Buffer.byteLength(value)<=16000,'infrastructure_log_invalid');return {id,content:value,instructionAuthority:false};},
    async update(actor,projectId,id,{quoteId,idempotencyKey,expectedRevision}){
      await auth(actor,projectId,'infrastructure.manage');const old=await resource(store,projectId,id);integer(expectedRevision);
      requireThat(old.revision===expectedRevision,'revision_conflict');requireThat(done.has(old.value.state),'resource_must_stop_and_settle');
      text(idempotencyKey);requireThat(idempotencyKey.length<=128,'invalid_identifier');
      const result=await api.request(actor,projectId,{quoteId,idempotencyKey:'replacement:'+id+':'+idempotencyKey});return {...result,replaces:id};
    },
    async reconcile(id){
      const leaseToken=digest({id,at:now(),random:randomUUID()});
      const work=await store.transaction(async tx=>{const r=await tx.read('infrastructure-resources',id);if(!r||done.has(r.value.state)||r.value.controllerLease?.until>now())return null;
        const v={...r.value,controllerLease:{token:leaseToken,until:now()+120000}};await tx.write('infrastructure-resources',id,v,r.revision);return v;});
      if(!work)return {processed:false};
      const update=async(fn)=>store.transaction(async tx=>{const r=await resource(tx,work.projectId,id);requireThat(r.value.controllerLease?.token===leaseToken&&r.value.controllerLease.until>now(),'stale_resource_controller');const changes=await fn(tx,r);return tx.write('infrastructure-resources',id,{...r.value,...changes},r.revision);});
      try{
        const stillAllowed=async()=>{try{const a=await admission(store,work.actor,work.projectId,work.profile.id);return digest(a.profile)===digest(work.profile);}catch(e){if(!['unauthenticated','not_found','scope_denied','infrastructure_not_enabled','infrastructure_profile_disabled','infrastructure_allowance_unavailable'].includes(e.code))throw e;return false;}};
        const allowed=await stillAllowed();
        const shouldStop=work.desired!=='running'||work.leaseUntil<=now()||!allowed||!work.attempted&&work.quote.expiresAt<=now();
        if(!work.attempted&&shouldStop){await update(async(tx,r)=>{const s=await settle(tx,r,{id:'unsent:'+id,resourceId:id,accountId:work.profile.accountId,asset:work.profile.asset,final:true,actual:'0'});return {...s,state:'cancelled',controllerLease:null};});}
        else{
          let observed;
          if(!work.attempted){
            requireThat(typeof ports.create==='function','infrastructure_provider_unavailable');
            // Persist before network I/O. A crash after this point is reconciled,
            // never retried as a new provision request.
            requireThat(await ports.verifyRelease?.({projectId:work.projectId,manifest:work.manifest})===true,'infrastructure_release_not_approved');
            await update(async(_tx,r)=>{
              requireThat(r.value.desired==='running'&&r.value.leaseUntil>now(),'resource_stop_requested');
              requireThat(r.value.quote.expiresAt>now(),'infrastructure_quote_expired');
              const a=await admission(_tx,work.actor,work.projectId,work.profile.id);requireThat(digest(a.profile)===digest(work.profile),'infrastructure_profile_changed');
              return {attempted:true,state:'provisioning'};
            });
            observed=await ports.create(work);
          } else {
            requireThat(typeof ports.inspect==='function','infrastructure_provider_unavailable');
            if(work.renewalPending&&!shouldStop){
              requireThat(await ports.verifyRelease?.({projectId:work.projectId,manifest:work.manifest})===true,'infrastructure_release_not_approved');
              observed=await ports.extend(work);
            } else observed=await ports.inspect(work);
            if(observed.outcome==='not_started'){
              requireThat(observed.operationId===id&&observed.accountId===work.profile.accountId,'infrastructure_observation_mismatch');
              const fresh=(await resource(store,work.projectId,id)).value;
              if(shouldStop||fresh.desired!=='running'||fresh.quote.expiresAt<=now()||!await stillAllowed()){
                await update(async(tx,r)=>({...await settle(tx,r,{id:'not-started:'+id,resourceId:id,accountId:work.profile.accountId,asset:work.profile.asset,final:true,actual:'0'}),state:'cancelled',terminal:true,controllerLease:null}));
                observed=null;
              } else {
                requireThat(await ports.verifyRelease?.({projectId:work.projectId,manifest:work.manifest})===true,'infrastructure_release_not_approved');
                observed=await ports.create(fresh);
              }
            }
          }
          if(observed){
          requireThat(observed&&observed.operationId===id&&observed.accountId===work.profile.accountId,'infrastructure_observation_mismatch');
          const fresh=(await resource(store,work.projectId,id)).value;
          const revoked=!(await stillAllowed()),expired=fresh.leaseUntil<=now();
          if((shouldStop||fresh.desired!=='running'||revoked||expired)&&observed.providerResourceId&&!observed.terminal){
            requireThat(typeof ports.stop==='function','infrastructure_provider_unavailable');
            observed=await ports.stop({...fresh,desired:revoked||expired?'deleted':fresh.desired,providerResourceId:observed.providerResourceId},observed);
            requireThat(observed.operationId===id&&observed.accountId===work.profile.accountId,'infrastructure_observation_mismatch');
          }
          if(observed.receipt)requireThat(observed.terminal===true&&await ports.verifyReceipt?.(work,observed.receipt)===true,'infrastructure_receipt_invalid');
          let costObservation=null;
          if(ports.cost&&observed.providerResourceId&&(observed.terminal||!work.costObservation||work.costObservation.observedAt<now()-3600000)){
            try{costObservation=await ports.cost(work);}catch{} // Unknown costs retain the original reservation.
          }
          await update(async(tx,r)=>{
            const endpoint=observed.endpoint??null;requireThat(endpoint===null||typeof endpoint==='string'&&/^https:\/\/[a-z0-9.-]+\/?$/.test(endpoint),'infrastructure_endpoint_invalid');
            const state=observed.outcome==='unknown'?'unknown':observed.terminal||['stopped','suspended','EXITED'].includes(observed.state)?'stopped':observed.ready?'running':observed.providerResourceId?'provisioning':'unknown';
            return {state,terminal:observed.terminal===true,storageRetained:observed.storageRetained??null,providerLeaseUntil:observed.providerLeaseUntil??r.value.providerLeaseUntil??null,renewalPending:r.value.renewalPending===true&&observed.providerLeaseUntil!==r.value.leaseUntil,failures:0,nextAttemptAt:null,...(costObservation?{costObservation}:{}),providerResourceId:observed.providerResourceId??r.value.providerResourceId??null,endpoint,observedAt:now(),controllerLease:null,error:observed.error??null,errorDetails:observed.errorDetails??null,...(observed.receipt?await settle(tx,r,observed.receipt):{})};
          });
          }
        }
        await store.transaction(async tx=>{const r=await resource(tx,work.projectId,id);if(!done.has(r.value.state)&&!r.value.terminal)return;
          for(const key of [grantKey(work.projectId,work.profile.id),'profile:'+work.profile.id]){const c=await tx.read('infrastructure-capacity',key);if(c&&c.value.active.includes(id))await tx.write('infrastructure-capacity',key,{...c.value,active:c.value.active.filter(x=>x!==id)},c.revision);}});
        return {processed:true,id};
      }catch(e){await update(async(_tx,r)=>({state:'unknown',failures:(r.value.failures??0)+1,nextAttemptAt:now()+Math.min(300000,5000*2**Math.min(r.value.failures??0,6)),error:typeof e.code==='string'?e.code:'infrastructure_outcome_unknown',controllerLease:null})).catch(()=>{});return {processed:true,id,state:'unknown'};}
    },
    async tick({after='',limit=20}={}){integer(limit,1,100);const rows=await store.pendingInfrastructure({after,limit});let processed=0;for(const r of rows){if(r.value.nextAttemptAt>now()&&r.value.desired==='running'&&r.value.leaseUntil>now())continue;if((await api.reconcile(r.id)).processed)processed++;}return {processed,nextCursor:rows.length===limit?rows.at(-1).id:null};}
  };
  return api;
}
