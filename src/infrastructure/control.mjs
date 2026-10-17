import {amount,copy,digest,integer,requireThat,shape,text,sourceText} from '../shared/index.mjs';
import {balance} from '../billing/index.mjs';
import {validateProfile} from './manifest.mjs';


// A policy allocates existing provider funding. It never creates money or gives
// its issuer the ability to change the enclosing policy or payment account.
export function createResourceControl({store,identity,now=()=>Date.now()}) {
  async function principal(actor,reader=store) {
    const credential=await identity.credential(actor,reader);
    requireThat(credential.kind==='owner','scope_denied');
    return credential.principalId;
  }
  async function owner(actor,reader) {
    const id=await principal(actor,reader);
    const p=(await reader.read('principals',id))?.value;
    const authority=(await reader.read('network','authority'))?.value;
    requireThat(p?.chainId===1&&p.address===authority?.ownerAddress,'scope_denied');
    return id;
  }
  async function issuer(actor,profileId,reader=store) {
    const id=await principal(actor,reader),row=await reader.read('infrastructure-controls',text(profileId));
    requireThat(row,'infrastructure_policy_unavailable');
    const p=(await reader.read('principals',id))?.value;
    const authority=(await reader.read('network','authority'))?.value;
    requireThat(row.value.operators.includes(id)||(p?.chainId===1&&p.address===authority?.ownerAddress),'scope_denied');
    return {id,row};
  }
  function publicPolicy(row) {
    const {profileId,enabled,expiresAt,totalLimit,perProjectLimit,dailyLimit,allocated}=row.value;
    return {profileId,enabled:enabled&&(expiresAt===null||expiresAt>now()),expiresAt,totalLimit,
      perProjectLimit,dailyLimit,allocated,remaining:(amount(totalLimit)-amount(allocated)).toString(),revision:row.revision};
  }
  return {
    async configure(actor,input) {
      shape(input,['profile','operators','enabled','expiresAt','totalLimit','perProjectLimit','dailyLimit','expectedRevision']);
      const profile=validateProfile(input.profile);
      const {operators,enabled,expiresAt,totalLimit,perProjectLimit,dailyLimit,expectedRevision}=input;
      integer(expectedRevision);amount(totalLimit);amount(perProjectLimit);amount(dailyLimit);
      requireThat(amount(perProjectLimit)>0n&&amount(perProjectLimit)<=amount(totalLimit),'invalid_infrastructure_limit');
      requireThat(typeof enabled==='boolean'&&(expiresAt===null||Number.isSafeInteger(expiresAt)&&expiresAt>now()),'invalid_infrastructure_policy');
      requireThat(Array.isArray(operators)&&operators.length>0&&operators.length<=16&&new Set(operators).size===operators.length,'invalid_infrastructure_operators');
      requireThat(amount(dailyLimit)>0n&&amount(dailyLimit)<=amount(totalLimit),'invalid_infrastructure_limit');
      return store.transaction(async tx=>{
        await owner(actor,tx);
        for(const id of operators)requireThat(await tx.read('principals',text(id)),'infrastructure_operator_unknown');
        const old=await tx.read('infrastructure-controls',profile.id),priorProfile=await tx.read('infrastructure-profiles',profile.id);
        requireThat((old?.revision??0)===expectedRevision,'revision_conflict');
        // New controlled profiles must be fresh. Legacy allocations cannot be
        // silently adopted with a zero commitment counter.
        requireThat(old||!priorProfile,'infrastructure_profile_already_exists');
        if(priorProfile){
          const {enabled:a,...before}=priorProfile.value,{enabled:b,...after}=profile;
          requireThat(digest(before)===digest(after),'infrastructure_profile_immutable');
        }
        const allocated=old?.value.allocated??'0';
        requireThat(amount(totalLimit)>=amount(allocated),'infrastructure_budget_below_commitments');
        const funds=await balance(tx,profile.fundingAccount,profile.asset);
        let otherLimits=0n,after='';
        for (;;) {
          const rows=await tx.list('infrastructure-controls',{after,limit:100});
          for (const r of rows) if(r.id!==profile.id&&r.value.fundingAccount===profile.fundingAccount&&r.value.asset===profile.asset)otherLimits+=amount(r.value.totalLimit);
          if(rows.length<100)break;after=rows.at(-1).id;
        }
        requireThat(amount(totalLimit)+otherLimits<=amount(funds.available)+amount(funds.reserved)+amount(funds.spent),'infrastructure_funding_insufficient');
        await tx.write('infrastructure-profiles',profile.id,profile,priorProfile?.revision??0);
        const result=await tx.write('infrastructure-controls',profile.id,{profileId:profile.id,fundingAccount:profile.fundingAccount,asset:profile.asset,operators,enabled,expiresAt,totalLimit,perProjectLimit,dailyLimit,allocated},expectedRevision);
        await tx.event({type:'infrastructure.policy_changed',profileId:profile.id,at:now(),revision:result.revision});
        return publicPolicy(result);
      });
    },
    async policy(actor,profileId) {
      const read=async reader=>{const {row}=await issuer(actor,profileId,reader);return {...publicPolicy(row),funds:await balance(reader,row.value.fundingAccount,row.value.asset)};};
      return store.snapshot?store.snapshot(read):store.transaction(read);
    },
    async grant(actor,projectId,input) {
      shape(input,['profileId','enabled','expiresAt','limit','expectedRevision','idempotencyKey','reason']);
      const {profileId,enabled,expiresAt,limit,expectedRevision,idempotencyKey,reason}=input;
      text(projectId);text(profileId);text(idempotencyKey);sourceText(reason,1000);integer(expectedRevision);amount(limit);
      requireThat(reason.length<=1000&&typeof enabled==='boolean'&&Number.isSafeInteger(expiresAt),'invalid_infrastructure_grant');
      const fingerprint=digest({projectId,profileId,enabled,expiresAt,limit,expectedRevision,reason});
      return store.transaction(async tx=>{
        const {id,row}=await issuer(actor,profileId,tx),policy=row.value;
        const requestId=digest({issuer:id,idempotencyKey}),previous=await tx.read('infrastructure-grant-requests',requestId);
        if(previous){requireThat(previous.value.fingerprint===fingerprint,'idempotency_conflict');return previous.value.result;}
        const project=(await tx.read('projects',projectId))?.value;
        requireThat(project&&!project.archivedAt&&!project.transfer,'project_unavailable');
        const profile=(await tx.read('infrastructure-profiles',profileId))?.value;
        requireThat(profile,'infrastructure_profile_unavailable');
        const key=digest({projectId,profileId}),old=await tx.read('infrastructure-grants',key);
        requireThat((old?.revision??0)===expectedRevision,'revision_conflict');
        const reserved=old?.value.reserved??'0',spent=old?.value.spent??'0';
        const exposure=amount(reserved)+amount(spent),nextLimit=amount(limit),oldLimit=amount(old?.value.limit??'0');
        requireThat(nextLimit>=exposure,'infrastructure_allowance_below_exposure');
        requireThat(!enabled||policy.enabled&&(policy.expiresAt===null||policy.expiresAt>now())&&profile.enabled,'infrastructure_policy_unavailable');
        requireThat(!enabled||expiresAt>now()&&(policy.expiresAt===null||expiresAt<=policy.expiresAt),'invalid_profile_expiry');
        // Revocation releases only unspent/unreserved allocation. Old pending
        // effects still settle against the same allowance and money account.
        requireThat(enabled||nextLimit===exposure,'revoked_infrastructure_grant_must_preserve_exposure');
        requireThat(nextLimit<=amount(policy.perProjectLimit)||nextLimit<=oldLimit,'infrastructure_project_limit');
        const allocated=amount(policy.allocated)-oldLimit+nextLimit;
        requireThat(allocated>=0n&&allocated<=amount(policy.totalLimit),'infrastructure_budget_exhausted');
        const value={projectId,profileId,enabled,expiresAt,limit,reserved,spent,issuerId:id,reason,updatedAt:now()};
        const saved=await tx.write('infrastructure-grants',key,value,expectedRevision);
        const result={...copy(value),revision:saved.revision};
        await tx.write('infrastructure-controls',profileId,{...policy,allocated:allocated.toString()},row.revision);
        await tx.write('infrastructure-grant-requests',requestId,{fingerprint,result,at:now()},0);
        await tx.event({type:'infrastructure.grant_changed',projectId,profileId,enabled,at:now()});
        return result;
      });
    },
    async grants(actor,profileId,{after='',limit=50}={}) {
      await issuer(actor,profileId);integer(limit,1,100);
      const rows=await store.list('infrastructure-grants',{after,limit});
      return {items:rows.filter(row=>row.value.profileId===profileId).map(row=>({...row.value,revision:row.revision})),nextCursor:rows.length===limit?rows.at(-1).id:null};
    },
    async checkSpend(reader,profileId,additional){
      const policy=(await reader.read('infrastructure-controls',profileId))?.value;
      if(!policy)return;
      let committed=0n,after='';
      for(;;){
        const rows=await reader.list('infrastructure-resources',{after,limit:100});
        for(const r of rows){const v=r.value;if(v.profile.id===profileId&&(v.createdAt>now()-86400000||v.billing==='reserved'))committed+=amount(v.reservedMaximum??v.quote.maximum);}
        if(rows.length<100)break;after=rows.at(-1).id;
      }
      requireThat(committed+amount(additional)<=amount(policy.dailyLimit),'infrastructure_daily_limit');
    },
    async active(reader,profileId) {
      const p=(await reader.read('infrastructure-controls',profileId))?.value;
      return !p||p.enabled&&(p.expiresAt===null||p.expiresAt>now());
    }
  };
}
