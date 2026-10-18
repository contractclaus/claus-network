import {digest,sameValue} from './store.mjs';
import {retryTime} from './providers.mjs';
const fail=c=>{throw Error('resource_cloudflare_'+c);};
const phases=['http_request_cache_settings','http_request_firewall_custom','http_ratelimit'];
const settingRules={ssl:['strict'],min_tls_version:['1.2','1.3'],always_use_https:['on'],automatic_https_rewrites:['on','off'],tls_1_3:['on','off'],browser_check:['on','off'],security_level:['essentially_off','low','medium','high','under_attack'],cache_level:['bypass','basic','simplified','aggressive'],browser_cache_ttl:'integer',development_mode:['on','off'],brotli:['on','off'],http2:['on','off'],http3:['on','off']};
export const cloudflareInputs={cloudflare_read:['view','phase','setting'],cloudflare_setting:['setting','value','expectedVersion'],cloudflare_rule:['phase','rule','expectedVersion'],cloudflare_rule_remove:['phase','ref','expectedVersion'],cloudflare_purge:['files','everything']};
export function cloudflareClient({environment=process.env,request=fetch}={}){
 const account=environment.CLOUDFLARE_WEBSITE_ACCOUNT,zone=environment.CLOUDFLARE_WEBSITE_ZONE;
 const configured=()=>!!environment.CLOUDFLARE_WEBSITE_TOKEN&&/^[a-f0-9]{32}$/.test(account??'')&&/^[a-f0-9]{32}$/.test(zone??'');
 async function call(path,{method='GET',body,missing=false}={}){
  if(!configured())fail('not_connected');
  if(!path.startsWith('/zones/'+zone+'/')&&!path.startsWith('/accounts/'+account+'/')&&path!=='/zones/'+zone)fail('scope_invalid');
  const r=await request('https://api.cloudflare.com/client/v4'+path,{method,headers:{authorization:'Bearer '+environment.CLOUDFLARE_WEBSITE_TOKEN,'content-type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(25000)});
  const raw=await r.text();if(Buffer.byteLength(raw)>4000000)fail('response_too_large');
  let data;try{data=JSON.parse(raw);}catch{fail('response_invalid');}
  if(missing&&r.status===404)return null;
  if(!r.ok||data.success!==true){const e=Error('resource_cloudflare_provider_'+r.status);e.status=r.status;e.codes=(data.errors??[]).map(x=>x.code);e.retryAt=retryTime(r.headers.get('retry-after'));throw e;}
  return data;
 }
 return {account,zone,configured,call};
}
export function managedCloudflare({store,environment=process.env,request=fetch,now=Date.now}){
 const client=cloudflareClient({environment,request}),base='/zones/'+client.zone;
 const api=async(p,o)=>(await client.call(base+p,o))?.result??null;
 const view=v=>({value:v,version:digest(v),observedAt:new Date(now()).toISOString()});
 async function identity(){const z=await api('');if(z.name!=='claus.si'||z.account?.id!==client.account)fail('identity_changed');}
 async function rules(phase){if(!phases.includes(phase))fail('phase_invalid');return await api('/rulesets/phases/'+phase+'/entrypoint',{missing:true});}
 function ruleBody(phase,r){
  if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['ref','description','expression','action','action_parameters','ratelimit','enabled'].includes(k)))fail('rule_invalid');
  if(!/^claus-[a-z0-9_-]{1,60}$/.test(r.ref??'')||typeof r.expression!=='string'||!r.expression||r.expression.length>3000||typeof r.description!=='string'||r.description.length>500||r.enabled!==undefined&&typeof r.enabled!=='boolean')fail('rule_invalid');
  const allowed=phase==='http_request_cache_settings'?['set_cache_settings']:phase==='http_ratelimit'?['block','managed_challenge']:['block','managed_challenge','js_challenge'];
  if(!allowed.includes(r.action))fail('rule_action_invalid');
  if(phase==='http_ratelimit'){
   const q=r.ratelimit;if(!q||!Array.isArray(q.characteristics)||!sameValue(q.characteristics,['cf.colo.id','ip.src'])||!Number.isSafeInteger(q.requests_per_period)||q.requests_per_period<1||q.requests_per_period>1000000||![10,60,600,3600].includes(q.period)||!Number.isSafeInteger(q.mitigation_timeout)||q.mitigation_timeout<0||q.mitigation_timeout>86400||Object.keys(q).some(k=>!['characteristics','period','requests_per_period','mitigation_timeout'].includes(k)))fail('rate_invalid');
  }else if(r.ratelimit!==undefined)fail('rate_invalid');
  if(phase==='http_request_cache_settings'){
   const p=r.action_parameters;if(!p||Object.keys(p).some(k=>!['cache','edge_ttl','browser_ttl','respect_strong_etags','origin_error_page_passthru'].includes(k))||typeof p.cache!=='boolean')fail('cache_invalid');
   for(const k of ['edge_ttl','browser_ttl'])if(p[k]!==undefined){const t=p[k];if(!t||Object.keys(t).some(k=>!['mode','default'].includes(k))||!['respect_origin','bypass_by_default','override_origin','bypass'].includes(t.mode)||t.default!==undefined&&(!Number.isSafeInteger(t.default)||t.default<0||t.default>31536000))fail('cache_ttl_invalid');}
   for(const k of ['respect_strong_etags','origin_error_page_passthru'])if(p[k]!==undefined&&typeof p[k]!=='boolean')fail('cache_invalid');
  }else if(r.action_parameters!==undefined)fail('rule_parameters_invalid');
  // Cache inclusion never turns a session-bearing request into a shared object.
  const cacheGuard=phase==='http_request_cache_settings'&&r.action_parameters.cache?' and http.request.method in {"GET" "HEAD"} and not any(http.request.headers["authorization"][*] ne "") and not any(http.request.headers["cookie"][*] ne "")':'';
  return {...r,enabled:r.enabled!==false,expression:'((http.host eq "claus.si" or ends_with(http.host, ".claus.si")) and ('+r.expression+'))'+cacheGuard};
 }
 function matches(actual,expected){
  if(Array.isArray(expected))return sameValue(actual,expected);
  if(expected&&typeof expected==='object')return !!actual&&typeof actual==='object'&&Object.entries(expected).every(([k,v])=>matches(actual[k],v));
  return sameValue(actual,expected);
 }
 async function call(operation,input,requestId){
  await identity();
  if(operation==='cloudflare_read'){
   if(input.view==='settings')return view((await api('/settings')).filter(x=>Object.hasOwn(settingRules,x.id)));
   if(input.view==='setting'){if(!Object.hasOwn(settingRules,input.setting))fail('setting_invalid');return view(await api('/settings/'+input.setting));}
   if(input.view==='rules')return view(await rules(input.phase));
   if(input.view==='email')return view(await api('/email/routing'));
   if(input.view==='dns')return view(await api('/dns_records?per_page=100'));
   fail('view_invalid');
  }
  if(typeof requestId!=='string'||!requestId||requestId.length>200)fail('request_invalid');
  const id='act_'+digest(['owner',requestId]).slice(0,24),old=await store.get('action',id);
  if(old&&(old.operation!==operation||!sameValue(old.input,input)))fail('request_conflict');if(old?.output){const l=await store.get('cloudflare-lock',old.prepared.lock);if(l?.active&&l.action===id)await store.change('cloudflare-lock',old.prepared.lock,l.revision,{...l,active:false,revision:l.revision+1});return old.output;}
  let p=old?.prepared;
  if(!p){
   if(operation==='cloudflare_setting'){
    const options=settingRules[input.setting];if(!options)fail('setting_invalid');
    if(options==='integer'?(!Number.isSafeInteger(input.value)||input.value<0||input.value>31536000):!options.includes(input.value))fail('setting_invalid');
    const before=await api('/settings/'+input.setting);if(digest(before)!==input.expectedVersion)fail('version_conflict');
    p={kind:'setting',before,path:'/settings/'+input.setting,body:{value:input.value},lock:'setting:'+input.setting};
   }else if(['cloudflare_rule','cloudflare_rule_remove'].includes(operation)){
    const before=await rules(input.phase);if(digest(before)!==input.expectedVersion)fail('version_conflict');const ref=operation==='cloudflare_rule'?input.rule?.ref:input.ref;if(!/^claus-[a-z0-9_-]{1,60}$/.test(ref??''))fail('rule_ref_invalid');
    const prior=before?.rules?.find(x=>x.ref===ref);p={kind:'rule',before,phase:input.phase,ref,prior,body:operation==='cloudflare_rule'?ruleBody(input.phase,input.rule):null,lock:'phase:'+input.phase};
   }else if(operation==='cloudflare_purge'){
    if(input.everything===true){if(input.files!==undefined)fail('purge_invalid');p={kind:'purge',body:{purge_everything:true},lock:'purge'};}
    else{if(!Array.isArray(input.files)||!input.files.length||input.files.length>30)fail('purge_invalid');for(const f of input.files){let u;try{u=new URL(f);}catch{fail('purge_invalid');}if(u.protocol!=='https:'||u.username||u.password||u.hash||u.hostname!=='claus.si'&&!u.hostname.endsWith('.claus.si'))fail('purge_scope');}p={kind:'purge',body:{files:input.files},lock:'purge'};}
   }else fail('operation_invalid');
   p=(await store.begin(id,operation,input,p)).row.result.prepared;
  }
  const row=await store.put('cloudflare-lock',p.lock,{action:id,revision:1,active:true});let lock=row.value;
  if(lock.active&&lock.action!==id)fail('original_change_pending');
  if(!lock.active)lock=await store.change('cloudflare-lock',p.lock,lock.revision,{action:id,revision:lock.revision+1,active:true});
  async function complete(result){const output=await store.complete(id,{id,...result,observedAt:new Date(now()).toISOString()});const l=await store.get('cloudflare-lock',p.lock);if(l.active&&l.action===id)await store.change('cloudflare-lock',p.lock,l.revision,{...l,revision:l.revision+1,active:false});return output;}
  async function matched(){if(p.kind==='purge')return null;if(p.kind==='setting'){const v=await api(p.path);return sameValue(v.value,p.body.value)?v:null;}const v=await rules(p.phase),r=v?.rules?.find(x=>x.ref===p.ref);return p.body?(matches(r,p.body)?v:null):(!r?{removed:true,ruleset:v}:null);}
  const previous=await matched();if(previous)return complete({state:'applied',result:previous});
  if(await store.dispatch(id)){
   try{
    if(p.kind==='setting'){if(digest(await api(p.path))!==digest(p.before))return complete({state:'conflict',retry:false});await api(p.path,{method:'PATCH',body:p.body});}
    else if(p.kind==='purge'){const result=await api('/purge_cache',{method:'POST',body:p.body});return complete({state:'purge_accepted',result});}
    else{
     const v=await rules(p.phase);if(digest(v)!==digest(p.before))return complete({state:'conflict',retry:false});
     if(!v){await api('/rulesets',{method:'POST',body:{name:'Claus '+p.phase,kind:'zone',phase:p.phase,rules:[p.body]}});}
     else if(!p.body){if(p.prior)await api('/rulesets/'+v.id+'/rules/'+p.prior.id,{method:'DELETE'});}
     else await api('/rulesets/'+v.id+'/rules'+(p.prior?'/'+p.prior.id:''),{method:p.prior?'PATCH':'POST',body:p.body});
    }
   }catch(e){if(e.status>=400&&e.status<500&&e.status!==408)return complete({state:'provider_rejected',httpStatus:e.status,codes:e.codes,retryAt:e.retryAt?new Date(e.retryAt).toISOString():null,retry:false});throw e;}
  }
  const result=await matched();return result?complete({state:'applied',result}):{id,state:'outcome_unknown',retry:false,next:'Repeat the identical operation, input and requestId to inspect the original outcome.'};
 }
 return {call,configured:client.configured};
}
