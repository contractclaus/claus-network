import {flyDiagnosticQuery,summarizeFlyDiagnostics} from './fly-diagnostics.mjs';
import {createHash} from 'node:crypto';
import {check,providerRequest} from './providers.mjs';

const pricingUrl='https://fly.io/pricing/';
const mib=1048576;
export function parseFlyPrice(html,manifest,config){
  const region=config.regions?.find(r=>r.code===manifest.region);
  check(region&&/^[A-Za-z ]+$/.test(region.name),'region_not_configured');
  check([1,2,4,6,8].includes(manifest.cpu)&&manifest.memoryMiB>=manifest.cpu*256&&manifest.memoryMiB<=65536&&manifest.memoryMiB%256===0,'fly_shape_unavailable');
  const row=html.match(new RegExp('shared-cpu-'+manifest.cpu+'x[^<]*</td>\\s*<td[^>]*data-region-price="([0-9.]+)"'));
  const factor=html.match(new RegExp('<option value="([0-9.]+)"[^>]*>'+region.name+'</option>'));
  const ram=html.match(/data-region-price="([0-9.]+)"[^>]*>[^<]*<\/span>\s*per GB per month/);
  check(row&&factor&&ram,'live_price_format_changed');
  const base=Number(row[1]),multiplier=Number(factor[1]),ramMonth=Number(ram[1]);
  check(base>0&&base<10&&multiplier>=1&&multiplier<5&&ramMonth>0&&ramMonth<100,'price_invalid');
  const hourly=(base+(manifest.memoryMiB-manifest.cpu*256)/1024*ramMonth/720)*multiplier;
  const egressMiB=manifest.egressBudgetMiB??1024;
  check(Number.isSafeInteger(egressMiB)&&egressMiB>=1&&egressMiB<=1000000,'egress_budget_invalid');
  check(Number.isSafeInteger(region.egressMicroUsdPerGb)&&region.egressMicroUsdPerGb>0,'egress_price_missing');
  // A buffer covers normal metering/termination delay, not a hard provider cap.
  const transferBytes=egressMiB*mib,headroomBytes=Math.max(128*mib,Math.ceil(transferBytes*.1));
  const extraMaximum=Math.ceil((transferBytes+headroomBytes)/1e9*region.egressMicroUsdPerGb)+25000;
  return {hourlyMicroUsd:String(Math.ceil(hourly*1000000*1.05)),extraMaximumMicroUsd:String(extraMaximum),priceSource:pricingUrl,priceSha256:createHash('sha256').update(html).digest('hex'),bootDiskGiB:0,shape:{cpu:manifest.cpu,memoryMiB:manifest.memoryMiB,region:manifest.region},networkBudget:{bytes:transferBytes,headroomBytes,egressMicroUsdPerGb:region.egressMicroUsdPerGb,scope:'all guest eth0 bytes counted conservatively',enforcement:'metered-stop-with-delay; not a provider hard cap'},billingMode:'postpaid',costMeaning:'Maximum operating authorization including compute and transfer estimate; actual invoice is reconciled separately'};
}
export function flyBilling({token,request=fetch,now=Date.now}){
  const api=(url,options)=>providerRequest(request,url,token(),options);
  async function account(config){
    const r=await api('https://api.fly.io/graphql',{method:'POST',body:{query:'query ClausBilling { organizations { nodes { id slug billable billingStatus isCreditCardSaved } } }'}});
    const org=r.data?.organizations?.nodes?.find(x=>x.slug===config.organization);
    check(!r.errors&&org&&org.id===config.organizationId,'provider_account_mismatch');
    check(org.billable===true&&org.billingStatus==='CURRENT'&&org.isCreditCardSaved===true,'postpaid_billing_unavailable');
    return {organization:org.slug,billable:true,billingStatus:org.billingStatus,paymentMethodPresent:true,observedAt:now(),providerDeposit:false};
  }
  async function metrics(query,config){
    const r=await api('https://api.fly.io/prometheus/'+encodeURIComponent(config.organization)+'/api/v1/query?query='+encodeURIComponent(query));
    check(r.status==='success'&&r.isPartial!==true&&r.data?.resultType==='vector'&&Array.isArray(r.data.result),'metrics_unavailable');return r.data.result;
  }
  return {
    account,
    async diagnostics(work,checkpoint,config){
      const id=checkpoint.providerResourceId;
      const series=await metrics(flyDiagnosticQuery(config.app,id),config);
      return summarizeFlyDiagnostics(series,config.app,id,now());
    },
    async readiness(config){const billing=await account(config);await metrics('count(fly_instance_net_sent_bytes)',config);return {billing,metricsAuthenticated:true};},
    async quote(work,config){
      const billing=await account(config);await metrics('count(fly_instance_net_sent_bytes)',config);
      const response=await request(pricingUrl,{redirect:'error',signal:AbortSignal.timeout(15000)});check(response.ok,'live_price_unavailable');
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;check(size<=2000000,'live_price_too_large');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      const price=parseFlyPrice(Buffer.concat(chunks).toString('utf8'),work.manifest,config);
      return {...price,billing,priceObservedAt:now()};
    },
    async usage(work,checkpoint,config){
      const instance=checkpoint.providerResourceId;check(/^[a-zA-Z0-9]+$/.test(instance)&&/^[a-z0-9-]+$/.test(config.app),'resource_identity_mismatch');
      const series=await metrics('fly_instance_net_sent_bytes{app="'+config.app+'",instance="'+instance+'",device="eth0"}',config);
      if(!series.length){check(now()-checkpoint.createdAt<180000,'metrics_missing');return {state:'awaiting-first-sample',observedAt:now()};}
      check(series.length===1&&Array.isArray(series[0].value),'metrics_ambiguous');
      const [seconds,raw]=series[0].value,bytes=Number(raw),sampleAt=Number(seconds)*1000;
      check(Number.isSafeInteger(bytes)&&bytes>=0&&Number.isFinite(sampleAt)&&sampleAt<=now()+30000&&sampleAt>=now()-120000,'metrics_stale');
      const previous=Number.isSafeInteger(checkpoint.traffic?.totalBytes)?checkpoint.traffic:{totalBytes:0,counterBytes:0};
      // On a restart, count the new counter in addition to all retained usage.
      const delta=bytes>=previous.counterBytes?bytes-previous.counterBytes:bytes;
      const totalBytes=previous.totalBytes+delta;
      const leases=1+(work.extensions?.at(-1)?.sequence??0),limit=checkpoint.price.networkBudget.bytes*leases;
      return {state:totalBytes>=limit?'limit-reached':'within-budget',counterBytes:bytes,totalBytes,sampleAt,observedAt:now(),limitBytes:limit};
    }
  };
}
