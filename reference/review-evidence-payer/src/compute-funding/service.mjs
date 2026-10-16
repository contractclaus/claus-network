import {createFundingService as createLegacyFundingService} from '../compute-funding-legacy/service.mjs';
import {Pool,neonConfig} from '@neondatabase/serverless';
import {createPublicClient,http} from 'viem';
import {mainnet,base} from 'viem/chains';
import {privateKeyToAccount} from 'viem/accounts';
import {timingSafeEqual} from 'node:crypto';
import fs from 'node:fs';
import {FUNDING as P,fundingHash,validateFundingApproval} from './policy.mjs';
import {fundingRepository} from './repository.mjs';
import {fundingWalletRepository} from './wallet-repository.mjs';
import {originalFundingExecutor} from './executor.mjs';
import {fundingReadPorts} from './ports.mjs';
import {validatePrepaidResource} from './prepaid.mjs';
import {readProviderHistory} from './provider-credit.mjs';
import {advanceFunding} from './cycle.mjs';
import {fundingReason,reconcileFundingOriginals,processFunding} from './recovery.mjs';
neonConfig.webSocketConstructor=WebSocket;
const origins={payer:'https://claus-ecosystem-payments.vercel.app',signer:'https://claus-inference.vercel.app'};
const validId=id=>typeof id==='string'&&/^claus-capital-compute-v1:[1-9][0-9]{0,8}:((claim|swap|approve|burn)|(receive|prepaid))$/.test(id);
export function authorized(header,secret){
 if(typeof secret!=='string'||secret.length<32||typeof header!=='string')return false;
 const a=Buffer.from(header),b=Buffer.from('Bearer '+secret);
 return a.length===b.length&&timingSafeEqual(a,b);
}
const json=v=>JSON.parse(JSON.stringify(v,(_,x)=>typeof x==='bigint'?String(x):x));
export function createFundingService({role,env=process.env,config,request=fetch}){
 let instance;
 function load(){
  if(instance)return instance;
  if(config.policyHash!==fundingHash(P))throw Error('compute_policy_mismatch');
  const binding={address:P.prepaidAddress,keyId:P.prepaidKeyId};
  const pool=new Pool({connectionString:role==='payer'?env.PAYMENT_DATABASE_URL:env.DATABASE_URL,max:2});pool.on('error',()=>{});
  const clients={1:createPublicClient({chain:mainnet,transport:http(env.ETHEREUM_RPC_URL||'https://ethereum-rpc.publicnode.com',{timeout:12000,retryCount:0})}),8453:createPublicClient({chain:base,transport:http(env.BASE_RPC_URL||'https://mainnet.base.org',{timeout:12000,retryCount:0})})};
  const store=role==='payer'?fundingRepository(pool,{binding}):null;
  const wallet=fundingWalletRepository(pool);
  const remote=async(target,body)=>{
   const r=await request(origins[target]+'/api/compute-funding',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+env.COMPUTE_FUNDING_SECRET},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(55000)});
   if(!r.ok)throw Error('compute_remote_unavailable');
   const text=await r.text();if(text.length>300000)throw Error('compute_remote_size');return JSON.parse(text);
  };
  const providerResourceRead=async()=>{
   const get=async(path)=>{
    const r=await request('https://api.surplusintelligence.ai/v1/payments/'+path,{headers:{authorization:'Bearer '+env.SURPLUS_CREDIT_KEY},redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw Error('compute_provider_unavailable');return r.json();
   };
   const [balance,deposit,topup]=await Promise.all([get('balance'),get('deposit-address'),get('auto-topup')]);
   return {providerAutoTopup:topup.enrolled,prepaid:validatePrepaidResource({balance,deposit,topup},binding)};
  };
  const exportOriginal=async(id)=>{
   if(!validId(id))throw Error('compute_original_id');
   const [,,step]=id.split(':');const cycleId=id.slice(0,-step.length-1);
   const row=await store.step(cycleId,step);if(!row)throw Error('compute_original_missing');
   const result=await pool.query('SELECT policy_hash,approval,state FROM claus_funding_cycles WHERE id=$1',[cycleId]);const c=result.rows[0];
   if(!c||c.policy_hash!==config.policyHash||fundingHash(c.approval)!==fundingHash(config.approval))throw Error('compute_original_policy');
   return {cycleId,step,row,approval:c.approval,policyHash:c.policy_hash,state:c.state};
  };
  const remoteStep=async(cycle,step,readOnly=false)=>{
   const value=await remote('payer',{action:'original',id:cycle+':'+step});
   if(value.policyHash!==config.policyHash||fundingHash(value.approval)!==fundingHash(config.approval)||value.cycleId!==cycle||value.step!==step||(!readOnly&&(value.state!=='active'||value.capitalActive!==true)))throw Error('compute_original_policy');
   return value.row;
  };
  const localStore=role==='payer'?store:{step:remoteStep};
  const readStore=role==='payer'?store:{step:(cycle,step)=>remoteStep(cycle,step,true)};
  // Receipt reads must survive unavailable signing keys. Resolve the fixed
  // account only when the separately admitted execution path needs it.
  let signingExecutor;
  const execute=(...args)=>{
   if(!signingExecutor){
    const account=privateKeyToAccount(env.SIGNER_PRIVATE_KEY);
    if(account.address.toLowerCase()!==(role==='payer'?P.payer:P.beneficiary))throw Error('compute_account_mismatch');
    signingExecutor=originalFundingExecutor({clients,accounts:{[role==='payer'?8453:1]:account},repositories:{[role==='payer'?8453:1]:wallet},fundingStore:localStore,approval:config.approval,binding,gasExposure:(cycle,chain)=>wallet.exposure(cycle,chain)});
   }
   return signingExecutor(...args);
  };
  const readReceipt=originalFundingExecutor({clients,accounts:{},repositories:{[role==='payer'?8453:1]:wallet},fundingStore:readStore,approval:config.approval,binding});
  const originalTransaction=async(id,transaction,limits)=>{
   if(transaction.chainId===8453)return execute(id,transaction,limits);
   const value=await remote('signer',{action:'execute',id});return value.receipt;
  };
  const ports=fundingReadPorts({clients,paymentPool:pool,binding,providerResourceRead,originalTransaction,contractPins:config.contractPins});
  ports.prepaidHistory=cursor=>readProviderHistory({request,key:env.SURPLUS_CREDIT_KEY,cursor});
  const reconcile=()=>reconcileFundingOriginals({store,approval:config.approval,originalReceipt:async original=>{
   if(original.transaction.chainId===8453)return readReceipt(original.id,original.transaction,{cycleId:original.cycle_id,step:original.step,readOnly:true});
   const value=await remote('signer',{action:'reconcile',id:original.id});return value.receipt;
  }});
  instance={pool,store,wallet,clients,binding,remote,execute,readReceipt,readStore,ports,exportOriginal,localStore,reconcile};return instance;
 }
 const admission=async()=>{
  if(env.COMPUTE_FUNDING_ENABLED!=='true')throw Error('compute_funding_inactive');
  validateFundingApproval(config.approval,{binding:{address:P.prepaidAddress,keyId:P.prepaidKeyId}});
  if(role==='payer'){
   const result=await load().pool.query("SELECT state,policy_hash FROM claus_capital_control WHERE id=true");
   if(result.rows[0]?.state!=='active'||result.rows[0]?.policy_hash!==config.approval.capitalPolicyHash)throw Error('compute_capital_mandate_inactive');
  }else{const status=await load().remote('payer',{action:'status'});if(!status.enabled||status.policyHash!==config.policyHash)throw Error('compute_capital_mandate_inactive');}

 };
 return {
  async handle(body){
   if(!body||typeof body!=='object')throw Error('compute_invalid_action');
   const fields=Object.keys(body).length;
   if(body.action==='status'&&fields===1){
    let enabled=true,reason=null;try{if(config.policyHash!==fundingHash(P))throw Error('compute_policy_mismatch');await admission();}catch(error){enabled=false;reason=fundingReason(error);}
    return {enabled,configured:env.COMPUTE_FUNDING_ENABLED==='true',reason,policyHash:config.policyHash,expiresAt:null,duration:config.approval.duration,capitalPolicyHash:config.approval.capitalPolicyHash,source:P.revenue,fundingRail:P.rail,chainId:8453,walletAddress:P.payer,providerCreditVerification:P.rail==='x402-wallet'?'not_required_for_wallet':'required_for_prepaid',prepaidReconciliation:P.rail==='x402-wallet'?'legacy_only':'provider-history-v1',receiptRecovery:true,role};
   }
   const payerAction=role==='payer'&&((['advance','reconcile'].includes(body.action)&&fields===1)||(body.action==='original'&&fields===2&&validId(body.id)));
   const signerAction=role==='signer'&&['execute','reconcile'].includes(body.action)&&fields===2&&validId(body.id);
   if(!payerAction&&!signerAction)throw Error('compute_invalid_action');
   const x=load();
   if(role==='payer'&&body.action==='original'&&Object.keys(body).length===2){let capitalActive=false;try{await admission();capitalActive=true;}catch{}return {...await x.exportOriginal(body.id),capitalActive};}
   if(role==='payer'&&body.action==='reconcile')return x.reconcile();
   if(role==='payer'&&body.action==='advance'&&Object.keys(body).length===1){
    return processFunding({reconcile:x.reconcile,admit:admission,
     advance:()=>advanceFunding({store:x.store,ports:x.ports,approval:config.approval,binding:x.binding}),
     observe:result=>x.pool.query("INSERT INTO claus_compute_funding_status(id,result,observed_at) VALUES(true,$1,now()) ON CONFLICT(id) DO UPDATE SET result=EXCLUDED.result,observed_at=EXCLUDED.observed_at",[result])});
   }
   if(signerAction){
    const [,,step]=body.id.split(':');if(!['claim','swap','approve','burn'].includes(step))throw Error('compute_wrong_chain');
    const cycle=body.id.slice(0,-step.length-1);
    if(body.action==='reconcile'){
     const original=await x.readStore.step(cycle,step);
     return {receipt:await x.readReceipt(body.id,original.transaction,{cycleId:cycle,step,readOnly:true})};
    }
    await admission();const original=await x.localStore.step(cycle,step);
    // Check the fixed route contracts on the chain before any signature.
    await x.ports.verifyPins();
    return {receipt:await x.execute(body.id,original.transaction,{cycleId:cycle,step,l1GasCap:P.l1GasPerCycleWei,baseGasCap:P.baseGasPerCycleWei})};
   }
   throw Error('compute_invalid_action');
  },
  async tick(){if(role!=='signer')throw Error('compute_wrong_role');return load().remote('payer',{action:'advance'});}
 };
}
export function installFundingRoutes(app,role,env=process.env){
 const config=JSON.parse(fs.readFileSync(new URL('../../config/compute-funding.json',import.meta.url)));
 const current=createFundingService({role,env,config});
 const legacyConfig=JSON.parse(fs.readFileSync(new URL('../../config/compute-funding-legacy.json',import.meta.url)));
 const legacy=createLegacyFundingService({role,env,config:legacyConfig});
 const service={
  async handle(body){
   if(typeof body?.id==='string'&&body.id.startsWith('claus-compute-operations-v1:')){
    if(!['original','reconcile'].includes(body.action))throw Error('compute_legacy_execution_inactive');
    return legacy.handle(body);
   }
   if(role==='payer'&&body?.action==='advance')await legacy.handle({action:'reconcile'});
   return current.handle(body);
  },tick:()=>current.tick()
 };
 app.post('/api/compute-funding',async c=>{
  if(!authorized(c.req.header('authorization'),env.COMPUTE_FUNDING_SECRET))return c.json({error:'unauthorized'},401);
  const raw=await c.req.text();if(raw.length>2048)return c.json({error:'request_too_large'},413);
  try{return c.json(json(await service.handle(JSON.parse(raw))));}catch(e){return c.json({error:/^(compute_|funding_)[a-z0-9_:]+$/.test(e.message)?e.message:'compute_operation_deferred'},409);}
 });
 if(role==='signer')app.get('/api/compute-funding/process',async c=>{
  if(!authorized(c.req.header('authorization'),env.CRON_SECRET))return c.json({error:'unauthorized'},401);
  try{return c.json(json(await service.tick()));}catch(e){return c.json({state:'deferred',reason:/^(compute_|funding_)[a-z0-9_:]+$/.test(e.message)?e.message:'compute_operation_deferred'});}
 });
 return service;
}
