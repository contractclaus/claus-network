import {flyTarget} from './fly-target.mjs';
import {runtimeReleaseApproved} from './release.mjs';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {check,runpodDriver,flyDriver} from './providers.mjs';

export const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
export const digest=v=>'sha256:'+createHash('sha256').update(canonical(v)).digest('hex');
const hashPattern=/^sha256:[a-f0-9]{64}$/;
const key=id=>'infrastructure:'+id;
const safeWork=w=>({id:w.id,projectId:w.projectId,profile:w.profile,manifest:w.manifest,quote:w.quote,createdAt:w.createdAt,leaseUntil:w.leaseUntil,extensions:w.extensions??[]});
const original=w=>{const {leaseUntil,extensions,...rest}=w;return rest;};

export function createInfrastructureBroker({ledger,config=()=>JSON.parse(process.env.CLAUS_INFRASTRUCTURE_PROVIDERS??'{"enabled":false,"profiles":[],"releases":[]}'),secret=()=>process.env.CLAUS_OCI_NETWORK_SECRET,request=fetch,now=()=>Date.now(),drivers,releaseStatus}={}){
  drivers??={runpod:runpodDriver({token:()=>process.env.CLAUS_RUNPOD_API_KEY,request,now}),fly:flyDriver({token:()=>process.env.CLAUS_FLY_API_TOKEN,request})};
  function profile(p,projectId){
    const c=config(),found=c.profiles?.find(x=>x.id===p.id);
    check(found&&found.profileHash===digest(p)&&found.accountId===p.accountId&&found.provider===p.provider,'profile_not_authorized');
    check(c.enabled===true&&found.enabled===true,'provider_not_enabled');
    if(found.provider==='fly'){
      const target=flyTarget(found,projectId);check(!c.profiles.some(other=>other.provider==='fly'&&other.app===target.app&&other.projectId!==target.projectId),'project_app_not_isolated');return target;
    }
    check(drivers[p.provider],'provider_unknown');return found;
  }
  const releaseApproved=releaseStatus??(w=>runtimeReleaseApproved(w,{request}));
  const sign=(operation,input,result)=>({...result,proof:createHmac('sha256',secret()).update(canonical({operation,input,result})).digest('hex')});
  function boundWork(w){
    check(w&&hashPattern.test(w.id)&&typeof w.projectId==='string'&&w.projectId.length<=128&&w.profile&&w.manifest&&w.quote,'work_invalid');
    check(Number.isSafeInteger(w.leaseUntil)&&Number.isSafeInteger(w.createdAt),'lease_invalid');return safeWork(w);
  }
  async function quote(input){
    check(input?.profile&&input.manifest&&hashPattern.test(input.requestHash),'quote_invalid');
    check(input.requestHash===digest({projectId:input.projectId,profile:input.profile,manifest:input.manifest,leaseSeconds:input.leaseSeconds}),'quote_binding_invalid');
    check(await releaseApproved(input),'release_not_approved');
    const p=profile(input.profile,input.projectId);check(Number.isSafeInteger(input.leaseSeconds)&&input.leaseSeconds>=60&&input.leaseSeconds<=input.profile.maxLeaseSeconds,'lease_invalid');
    const price=await drivers[p.provider].quote(input,p);
    const hourly=BigInt(price.hourlyMicroUsd);check(hourly>0n&&hourly<=BigInt(p.maxHourlyMicroUsd),'price_over_limit');
    const maximum=(hourly*BigInt(input.leaseSeconds+(p.shutdownHeadroomSeconds??300))+3599n)/3600n;
    check(maximum<=BigInt(input.profile.maxPerLease),'quote_over_limit');
    const id=digest({request:input.requestHash,price,at:now()}),result={id,requestHash:input.requestHash,accountId:p.accountId,asset:input.profile.asset,maximum:maximum.toString(),expiresAt:now()+300000,totalLifecycle:true,...price};
    check(input.profile.asset==='USD','billing_asset_invalid');
    await ledger.reserveOci('infrastructure-quote:'+id,{input,result},{input,result,phase:'quoted'});
    return result;
  }
  async function validateQuote(work,q=work.quote){
    const saved=(await ledger.get('infrastructure-quote:'+q.providerQuoteId))?.result;
    check(saved?.input&&saved.result,'quote_missing');
    check(saved.result.expiresAt>now()&&saved.result.maximum===q.maximum&&saved.input.leaseSeconds===q.leaseSeconds,'quote_expired_or_changed');
    check(saved.input.projectId===work.projectId&&digest(saved.input.profile)===digest(work.profile)&&digest(saved.input.manifest)===digest(work.manifest),'quote_binding_invalid');
    return saved.result;
  }
  const result=(w,r)=>({operationId:w.id,accountId:w.profile.accountId,providerResourceId:r.providerResourceId??null,state:r.state??'unknown',outcome:r.outcome??null,ready:r.ready===true,terminal:r.terminal===true,stopped:r.stopped===true,endpoint:r.endpoint??null,storageRetained:r.storageRetained??null,providerLeaseUntil:r.leaseUntil??w.leaseUntil,hourlyMicroUsd:r.hourlyMicroUsd??null,costObservation:r.costObservation??null,error:r.error??null,errorDetails:r.errorDetails??null,...(r.receipt?{receipt:r.receipt}:{})});
  async function locked(work,operation){
    const token=randomUUID(),row=await ledger.infrastructureLock(key(work.id),token,now());check(row,'resource_busy');
    let current=row.result;
    const record=async observed=>{
      current={...current,...observed,observedAt:now()};
      if(observed.terminal&&!current.terminalAt)current.terminalAt=now();
      await ledger.infrastructureSave(key(work.id),token,current,now());return current;
    };
    try{check(digest(original(current.work))===digest(original(work)),'work_changed');return await operation(()=>current,record);}finally{await ledger.infrastructureUnlock(key(work.id),token);}
  }
  async function inspectLocked(work,get,record){
    const c=get();
    if(c.receipt||c.terminal)return result(work,c);
    if(c.phase==='prepared')return result(work,{...c,outcome:'not_started'});
    const driver=drivers[c.providerConfig.provider];
    let observed=await driver.inspect(c.work,c,c.providerConfig);
    const overPrice=observed.hourlyMicroUsd&&BigInt(observed.hourlyMicroUsd)>BigInt(c.price.hourlyMicroUsd);
    const revoked=!config().enabled||!config().profiles?.some(p=>p.id===c.providerConfig.id&&p.enabled&&p.profileHash===c.providerConfig.profileHash);
    const mustStop=c.leaseUntil<=now()||revoked||overPrice||c.deletionRequested;
    const releaseRevoked=mustStop?false:!await releaseApproved(c.work);
    if((mustStop||releaseRevoked)&&observed.providerResourceId&&!observed.terminal){
      await record({...observed,deletionRequested:true});
      observed=await driver.stop(c.work,get(),true,c.providerConfig);
    }
    if(!mustStop&&!releaseRevoked&&c.leaseUntil>now()&&observed.stopped&&!observed.terminal&&!c.stopRequested&&work.manifest.mode!=='job'&&driver.resume){
      const attempts=(c.resumeAttempts??[]).filter(at=>at>now()-3600000);
      if(attempts.length<3&&(!c.resumeAttemptedAt||c.resumeAttemptedAt<=now()-60000)){
        // Keep the existing resource ID and original paid lease. Record intent
        // before the network call; a lost response does not create a replacement.
        await record({...observed,resumeAttempts:[...attempts,now()],resumeAttemptedAt:now()});
        observed=await driver.resume(c.work,get(),c.providerConfig);
      }
    }
    return result(work,await record({...observed,outcome:observed.outcome??null}));
  }
  async function create(work){
    if(!await ledger.get(key(work.id))){
      const p=profile(work.profile,work.projectId),price=await validateQuote(work);check(await releaseApproved(work),'release_not_approved');
      check(work.leaseUntil>now()&&work.leaseUntil<=work.createdAt+work.quote.leaseSeconds*1000,'lease_invalid');
      check(work.extensions.length===0,'extension_invalid');
      await ledger.reserveOci(key(work.id),original(work),{work,providerConfig:p,price,leaseUntil:work.leaseUntil,phase:'prepared',createdAt:now(),providerResourceId:null});
    }
    return locked(work,async(get,record)=>{
      const c=get();if(c.phase!=='prepared')return inspectLocked(work,get,record);
      profile(work.profile,work.projectId);await validateQuote(work);check(await releaseApproved(work),'release_not_approved');check(c.leaseUntil>now(),'lease_expired');
      await record({phase:'dispatching'});
      try{return result(work,await record(await drivers[c.providerConfig.provider].create(c.work,c.price,c.providerConfig)));}
      catch(e){
        // Only a definite request rejection proves no resource was created.
        // A timeout or 5xx keeps the original operation and all reserved money.
        if([400,401,402,403,413,422].includes(e.status)){
          const receipt={id:'provider-rejected:'+work.id,resourceId:work.id,accountId:work.profile.accountId,asset:work.profile.asset,final:true,actual:'0'};
          return result(work,await record({state:'rejected',terminal:true,ready:false,receipt,error:e.message,errorDetails:e.details??null}));
        }
        await record({state:'unknown',outcome:'unknown',ready:false,error:'provider_create_outcome_unknown'});throw e;
      }
    });
  }
  async function operate(operation,input){
    if(operation==='verify_release')return {approved:await releaseApproved(input)};
    if(operation==='readiness'){
      const c=config(),items=[];
      const profiles=c.profiles?.length?c.profiles:[{id:'runpod',provider:'runpod',enabled:false},...(process.env.CLAUS_FLY_API_TOKEN?[{id:'fly',provider:'fly',organization:'claus-network',enabled:false}]:[])];
      for(const p of profiles)try{items.push({id:p.id,provider:p.provider,enabled:c.enabled===true&&p.enabled===true,...await drivers[p.provider].readiness(p)});}catch(e){items.push({id:p.id,provider:p.provider,enabled:false,authenticated:false,error:/^infrastructure_[a-z0-9_]+$/.test(e.message)?e.message:'provider_unavailable'});}
      return {enabled:c.enabled===true,profiles:items,configured:items.length>0};
    }
    if(operation==='quote')return quote(input);
    const work=boundWork(input);
    if(operation==='create')return create(work);
    const exists=await ledger.get(key(work.id));
    if(operation==='inspect'&&!exists)return result(work,{outcome:'not_started'});
    check(exists,'resource_missing');
    return locked(work,async(get,record)=>{
      const c=get(),driver=drivers[c.providerConfig.provider];
      if(operation==='inspect')return inspectLocked(work,get,record);
      if(operation==='extend'){
        check(!c.terminal&&!c.stopped&&!c.deletionRequested&&c.providerResourceId,'resource_not_running');profile(work.profile,work.projectId);check(await releaseApproved(work),'release_not_approved');
        if(c.leaseUntil===work.leaseUntil){check(digest(c.work)===digest(work),'extension_invalid');return result(work,c);}
        check(c.leaseUntil>now()&&work.leaseUntil>c.leaseUntil&&work.leaseUntil<=now()+work.profile.maxLeaseSeconds*1000,'lease_invalid');
        const before=c.work.extensions??[],added=work.extensions.at(-1);
        check(work.extensions.length===1&&added.sequence===(before.at(-1)?.sequence??0)+1&&added.previousUntil===c.leaseUntil,'extension_invalid');
        const price=await validateQuote(work,added.quote);
        check(work.leaseUntil===c.leaseUntil+added.quote.leaseSeconds*1000,'extension_invalid');
        return result(work,await record({work,leaseUntil:work.leaseUntil,price:{...c.price,hourlyMicroUsd:BigInt(price.hourlyMicroUsd)>BigInt(c.price.hourlyMicroUsd)?price.hourlyMicroUsd:c.price.hourlyMicroUsd}}));
      }
      if(operation==='stop'||operation==='delete'){
        if(c.terminal)return result(work,c);
        await record({stopRequested:true,...(operation==='delete'?{deletionRequested:true}:{})});
        return result(work,await record(await driver.stop(c.work,get(),operation==='delete',c.providerConfig)));
      }
      if(operation==='logs')return {content:await driver.logs(c.work,c,c.providerConfig),instructionAuthority:false};
      if(operation==='cost'){const costObservation=await driver.cost(c.work,c,c.providerConfig);await record({costObservation});return {costObservation};}
      throw Error('infrastructure_operation_invalid');
    });
  }
  return {
    async call({operation,input}){check(typeof secret()==='string'&&secret().length>=24,'not_configured');const result=await operate(operation,input);return sign(operation,input,result);},
    async guard(){const rows=await ledger.infrastructureDue(now(),5);let processed=0,errors=0;for(const row of rows)try{await operate('inspect',row.result.work);processed++;}catch{errors++;}return {processed,errors};}
  };
}
