import {createPublicClient,http,decodeAbiParameters} from 'viem';
import {mainnet} from 'viem/chains';
import {privateKeyToAccount} from 'viem/accounts';
import {neon} from '@neondatabase/serverless';
import {walletService} from '../wallet.js';
import {walletRepository} from '../wallet-store.js';
import {createNetworkAccess} from '../jobs-wallet/network.js';
import {programReadRoutes} from '../programs/read-routes.js';
import {createProgramSourcePublisher} from '../programs/source.js';
import {createProgramVerifier} from '../programs/verification.js';
import {capitalEvidence,capitalDecision} from './evidence.mjs';
import {template} from './investment.mjs';
import {launchId,exactLaunch,launchPins,launchCost,launchRegistered,launchCommitted} from './launch.mjs';
import {OWNER,MANDATE,LIMITS,check,same,digest,keys} from './policy.mjs';
import {guide} from './guide.mjs';
export async function capitalRemote(origin,secret,body,request=fetch){
 const r=await request(origin+'/api/capital',{method:'POST',redirect:'error',signal:AbortSignal.timeout(55000),headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:JSON.stringify(body)});
 const raw=await r.text();check(raw.length<=2000000,'remote_size');const value=JSON.parse(raw);check(r.ok,value?.error?.replace(/^capital_/,'')??'remote_unavailable');return value;
}
export function capitalService({network,repo,client,account,readRows,enabled,payer,provider,verify,source}){
 const observer=walletService({account:{address:OWNER},clients:{1:client},repository:repo,policy:async()=>({enabled:false})});
 async function admit(){check(enabled(),'execution_disabled');check((await payer('admission',{})).active===true,'mandate_inactive');}
 async function bundle(id){check(/^capital-launch:[0-9a-f]{64}$/.test(id),'launch_id');const b=await repo.release(id);check(b?.kind==='capital-launch','original_missing');return b;}
 async function proofFor(input){const proof=await capitalEvidence(network,input.reference);capitalDecision(input,proof);return proof;}
 async function exact(b){
  const p=await proofFor(b.decision);check(p.reportArtifactHash===b.proof.reportArtifactHash&&p.judgeHash===b.proof.judgeHash&&digest(p.capital)===digest(b.capital),'review_changed');
  await launchPins(client);const r=await provider(b.capital.execution.providerLaunchId);return exactLaunch(b.capital,p,r,Math.floor(Date.now()/1000));
 }
 return {
  async guide(){return guide;},
  async overview(){return {mandate:MANDATE,enabled:enabled(),limits:LIMITS,launchCommittedWei:String(launchCommitted(await readRows())),investment:await payer('overview',{}),launches:(await readRows()).map(r=>({id:r.id,state:r.status,transactionHash:r.result?.transactionHash??null}))};},
  async template(){return {source:template.standardInput.sources,compilerProfile:template.profile.profile,entry:template.entry,contract:template.contract,abi:template.abi,creationBytecode:template.creationBytecode,runtimeTemplateHash:template.runtimeTemplateHash,instructions:'The real counterparty deploys one agreement on Base using its wallet. Predict its CREATE address from its nonce first; termsHash includes that address. Use the exact source path and Network compiler profile. No proxy. Request a capital review with real terms and this exact template; fund signs only a payee-bound USDC authorization. The counterparty relays it. For milestone release request a second independent capital review with actual delivery evidence; after expiry anyone can refund to Claus. This template alone is not approval.'};},
  async source(input){return source(input);},
  async evidence(input){const p=await capitalEvidence(network,input);return {...p,findingHashes:p.findings.map(digest)};},
  async review(input){return proofFor(input);},
  async prepare(input){
   await admit();const proof=await proofFor(input);
   if(proof.capital.action!=='launch')return payer('prepare',input);
   const id=launchId(proof.capital),old=await repo.release(id);
   if(old){check(digest(old.decision)===digest(input),'original_decision_conflict');return this.status({id});}
   const value={kind:'capital-launch',id,decision:input,capital:proof.capital,proof:{reportArtifactHash:proof.reportArtifactHash,judgeHash:proof.judgeHash},createdAt:new Date().toISOString()};
   const transaction=await exact(value);await repo.attest(id,value);await observer.prepare(id,transaction);return this.status({id});
  },
  async status(input){
   keys(input,['id']);if(/^capital-investment:[a-f0-9]{64}$/.test(input.id))return payer('status',input);
   const b=await bundle(input.id),result=await observer.status(b.id);let registration=null,verification=[];
   if(result?.status==='included'&&!result.observationError){
    registration=await launchRegistered(client,b.capital,result.result.receipt);
    const p=await proofFor(b.decision);
    for(const c of b.capital.execution.components){const artifact=p.artifacts[c.buildId],parameters=artifact.abi.find(x=>x.type==='constructor')?.inputs??[];
     const args=parameters.length?decodeAbiParameters(parameters,c.constructorArgs):[];
     const result=await verify({address:c.address,artifact,args});verification.push({address:c.address,...result});if(!result.verified)break;}
   }
   return {id:b.id,result,registration,verification,live:!!registration&&verification.length===b.capital.execution.components.length&&verification.every(x=>x.verified===true)&&result?.result?.confirmation==='safe',next:'Continue the same original id. An included transaction is not a verified live launch until registration, sources and safe confirmation are present.'};
  },
  async advance(input){
   keys(input,['id']);if(/^capital-investment:[a-f0-9]{64}:(fund|release)$/.test(input.id))return payer('advance',input);
   const b=await bundle(input.id);await admit();const existing=await repo.get(b.id);
   if(existing?.signed)return this.status(input); // no new payload on an unknown outcome
   const expected=await exact(b);
   const service=walletService({account:{address:OWNER,signTransaction:async tx=>{
    await admit();check(await repo.active(1)===b.id,'nonce_lock');const row=await repo.get(b.id);check(row?.status==='signing'&&!row.signed,'original_changed');
    const fresh=await exact(b);check(digest(fresh)===digest(expected),'transaction_changed');
    launchCost(tx,fresh,launchCommitted(await readRows()),await client.getBalance({address:OWNER}));
    const key=account();check(same(key.address,OWNER),'owner_identity');return key.signTransaction(tx);
   }},clients:{1:client},repository:repo,policy:async()=>({enabled:enabled()&&(await payer('admission',{})).active===true,mode:'production',chainWrite:true,externalTransfer:true,blockingRules:[],revision:MANDATE})});
   if(!existing)await service.prepare(b.id,expected);
   const result=await service.execute(b.id);return {id:b.id,result};
  }
 };
}
export function productionCapital(env=process.env){
 const repo=walletRepository(),sql=neon(env.DATABASE_URL),network=createNetworkAccess({env,extraRoutes:programReadRoutes,maximumResponseBytes:1500000});
 const client=createPublicClient({chain:mainnet,transport:http(env.ETHEREUM_RPC_URL??'https://ethereum-rpc.publicnode.com',{timeout:12000,retryCount:0})});
 const verifier=createProgramVerifier({repositoryStore:repo});
 return capitalService({network,repo,client,account:()=>privateKeyToAccount(env.SIGNER_PRIVATE_KEY),enabled:()=>env.CAPITAL_EXECUTION_ENABLED==='true',
  readRows:()=>sql`SELECT id,status,signed,result FROM claus_wallet_actions WHERE id LIKE 'capital-launch:%'`,
  payer:(operation,input)=>capitalRemote('https://claus-ecosystem-payments.vercel.app',env.CAPITAL_EXECUTION_SECRET,{operation,input}),
  provider:async id=>{check(/^[A-Za-z0-9_-]{16,128}$/.test(id),'provider_id');const r=await fetch('https://api.programmable.market/v3/custom-launches/'+id,{redirect:'error',headers:{authorization:'Bearer '+env.PROGRAMMABLE_API_KEY},signal:AbortSignal.timeout(15000)});check(r.ok,'provider_unavailable');const raw=await r.text();check(raw.length<=1500000,'provider_size');return JSON.parse(raw);},
  verify:verifier,source:input=>createProgramSourcePublisher({repositoryStore:repo}).publish(input)});
}
