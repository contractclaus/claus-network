import {createPublicClient,http,decodeAbiParameters} from 'viem';
import {mainnet} from 'viem/chains';
import {neon} from '@neondatabase/serverless';
import {walletService} from '../wallet.js';
import {walletRepository} from '../wallet-store.js';
import {createNetworkAccess} from '../jobs-wallet/network.js';
import {programReadRoutes} from '../programs/read-routes.js';
import {createProgramSourcePublisher} from '../programs/source.js';
import {createProgramVerifier} from '../programs/verification.js';
import {capitalEvidence,capitalDecision} from './evidence.mjs';
import {template} from './investment.mjs';
import {launchRegistered,launchCommitted} from './launch.mjs';
import {OWNER,MANDATE,LIMITS,check,keys} from './policy.mjs';
import {guide} from './guide.mjs';
export async function capitalRemote(origin,secret,body,request=fetch){
 const r=await request(origin+'/api/capital',{method:'POST',redirect:'error',signal:AbortSignal.timeout(55000),headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:JSON.stringify(body)});
 const raw=await r.text();check(raw.length<=2000000,'remote_size');const value=JSON.parse(raw);check(r.ok,value?.error?.replace(/^capital_/,'')??'remote_unavailable');return value;
}
export const launchPolicy=Object.freeze({enabled:false,reason:'owner_prohibits_self_issued_tokens',externalProjects:'dedicated-gateway-required'});
export function capitalService({network,repo,client,readRows,enabled,payer,verify,source}){
 const observer=walletService({account:{address:OWNER},clients:{1:client},repository:repo,policy:async()=>({enabled:false})});
 async function admit(){check(enabled(),'execution_disabled');check((await payer('admission',{})).active===true,'mandate_inactive');}
 async function bundle(id){check(/^capital-launch:[0-9a-f]{64}$/.test(id),'launch_id');const b=await repo.release(id);check(b?.kind==='capital-launch','original_missing');return b;}
 async function proofFor(input){const proof=await capitalEvidence(network,input.reference);capitalDecision(input,proof);return proof;}
 return {
  async guide(){return guide;},
  async overview(){return {mandate:MANDATE,enabled:enabled(),limits:LIMITS,launchPolicy,launchCommittedWei:String(launchCommitted(await readRows())),investment:await payer('overview',{}),launches:(await readRows()).map(r=>({id:r.id,state:r.status,transactionHash:r.result?.transactionHash??null}))};},
  async template(){return {source:template.standardInput.sources,compilerProfile:template.profile.profile,entry:template.entry,contract:template.contract,abi:template.abi,creationBytecode:template.creationBytecode,runtimeTemplateHash:template.runtimeTemplateHash,instructions:'The real counterparty deploys one agreement on Base using its wallet. Predict its CREATE address from its nonce first; termsHash includes that address. Use the exact source path and Network compiler profile. No proxy. Request a capital review with real terms and this exact template; fund signs only a payee-bound USDC authorization. The counterparty relays it. For milestone release request a second independent capital review with actual delivery evidence; after expiry anyone can refund to Claus. This template alone is not approval.'};},
  async source(input){return source(input);},
  async evidence(input){const p=await capitalEvidence(network,input);return {...p,findingHashes:p.findings.map(digest)};},
  async review(input){return proofFor(input);},
  async prepare(input){
   await admit();const proof=await proofFor(input);
   if(proof.capital.action!=='launch')return payer('prepare',input);
   // The legacy adapter can only issue through Claus' fixed owner wallet.
   // Independent-project launches require a separate verified gateway.
   check(false,'self_token_launch_disabled');
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
   const b=await bundle(input.id),existing=await repo.get(b.id);
   if(existing?.signed)return this.status(input); // retain read-only original recovery
   check(false,'self_token_launch_disabled');
  }
 };
}
export function productionCapital(env=process.env){
 const repo=walletRepository(),sql=neon(env.DATABASE_URL),network=createNetworkAccess({env,extraRoutes:programReadRoutes,maximumResponseBytes:1500000});
 const client=createPublicClient({chain:mainnet,transport:http(env.ETHEREUM_RPC_URL??'https://ethereum-rpc.publicnode.com',{timeout:12000,retryCount:0})});
 const verifier=createProgramVerifier({repositoryStore:repo});
 return capitalService({network,repo,client,enabled:()=>env.CAPITAL_EXECUTION_ENABLED==='true',
  readRows:()=>sql`SELECT id,status,signed,result FROM claus_wallet_actions WHERE id LIKE 'capital-launch:%'`,
  payer:(operation,input)=>capitalRemote('https://claus-ecosystem-payments.vercel.app',env.CAPITAL_EXECUTION_SECRET,{operation,input}),

  verify:verifier,source:input=>createProgramSourcePublisher({repositoryStore:repo}).publish(input)});
}
