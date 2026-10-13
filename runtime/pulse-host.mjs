import {Pool,neonConfig} from '@neondatabase/serverless';
import ws from 'ws';
import {createPublicClient,http,parseAbi,decodeAbiParameters} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {openPostgresStore} from '../src/postgres/index.mjs';
import {createSealer} from '../adapters/secrets.mjs';
import {createSignalPublisher} from '../adapters/signal-publisher.mjs';
import {createApplication} from './server.mjs';
import {createClient} from '../interfaces/sdk.mjs';
import {createPulseProvider,createPulseProviderWorker} from '../reference/pulse-providers.mjs';
import {createPulsePipeline} from '../reference/pulse-pipeline.mjs';
import {createPulseScheduler} from '../reference/pulse-scheduler.mjs';
import {requireThat,digest} from '../src/shared/index.mjs';

export async function createPulseHost(env=process.env){
 const config=JSON.parse(env.CLAUS_PULSE_CONFIG);
 requireThat(['observer','evaluator','consumer'].includes(config.role)&&[1,11155111].includes(config.chainId),'invalid_reference_configuration');
 const rpc=value=>{const url=new URL(value);requireThat(url.protocol==='https:','invalid_reference_rpc');
  return createPublicClient({transport:http(url.href,{retryCount:0,timeout:15000}),cacheTime:0});};
 requireThat(new URL(env.CLAUS_PULSE_PRIMARY_RPC).hostname!==new URL(env.CLAUS_PULSE_SECONDARY_RPC).hostname,'independent_rpc_required');
 const primary=rpc(env.CLAUS_PULSE_PRIMARY_RPC),secondary=rpc(env.CLAUS_PULSE_SECONDARY_RPC);
 const provider=createPulseProvider({role:config.role,chainId:config.chainId,primary,secondary});
 const client=createClient({origin:env.CLAUS_NETWORK_API_ORIGIN??'https://claus-network-api.vercel.app',token:env.CLAUS_PROJECT_CREDENTIAL});
 const worker=createPulseProviderWorker({client,projectId:config.projectId,serviceId:config.serviceId,provider});
 neonConfig.webSocketConstructor=ws;
 const store=await openPostgresStore({pool:new Pool({connectionString:env.CLAUS_NETWORK_DATABASE_URL,max:2,connectionTimeoutMillis:8000})});
 let scheduler;
 if(config.role==='consumer'){
  requireThat(config.budget.projectId===config.projectId&&config.schedule.projectId===config.projectId&&
   config.budget.chainId===config.chainId&&config.budget.grantId===config.grantId,'reference_configuration_mismatch');
  const app=createApplication({store,origin:env.CLAUS_NETWORK_ORIGIN,rateSalt:env.CLAUS_NETWORK_RATE_SALT,
   chainPorts:config.chainId===1?{mainnetClient:primary}:{client:primary}});
  const signer=privateKeyToAccount(env.CLAUS_SIGNAL_PUBLISHER_KEY);
  const publisher=createSignalPublisher({store,client:primary,signer,sealer:createSealer(env.CLAUS_NETWORK_SEALING_KEY),
   identity:app.identity,services:app.services,signals:app.signals,budget:config.budget});
  const abi=parseAbi(['function version() view returns(uint64)','function configuration() view returns(bytes)']);
  const readRule=async()=>{
   const block=await primary.getBlock({blockTag:'latest'});
   const [version,data]=await Promise.all(['version','configuration'].map(functionName=>primary.readContract({
    address:config.evaluator,abi,functionName,blockNumber:block.number})));
   const [threshold,age]=decodeAbiParameters([{type:'uint256'},{type:'uint256'}],data);
   return {version:Number(version),thresholdWei:String(threshold),maximumAge:Number(age)};
  };
  const pipeline=createPulsePipeline({client,projectId:config.projectId,observerServiceId:config.observerServiceId,
   evaluatorServiceId:config.evaluatorServiceId,consumerProvider:provider,publisher,grantId:config.grantId,
   signal:{chainId:config.chainId},readRule});
  scheduler=createPulseScheduler({store,jobs:app.jobs,pipeline,config:config.schedule});
 }
 return {store,async tick(){
  const admission=(await store.read('reference-pulse-admissions',config.projectId))?.value;
  requireThat(admission?.configHash===digest(config),'reference_configuration_not_admitted');
  // Expiry stops fresh pipeline work inside the scheduler. Reconciliation and
  // public reads remain available; provider services enforce their own expiry.
  let result,service;
  try{service=Date.now()<config.expiresAt?await worker.tick():{state:'expired'};}
  catch(error){service={state:'unavailable',error:error.code??'reference_unavailable'};}
  // A provider outage must not prevent settling an already-broadcast write.
  try{result=scheduler?{...await scheduler.tick(),service:service.state}:service;}
  catch(error){result={state:'unavailable',error:error.code??'reference_unavailable'};}
  await store.transaction(async tx=>{
   const key='pulse:'+config.projectId,row=await tx.read('worker-health',key);
   await tx.write('worker-health',key,{...result,observedAt:Date.now(),expiresAt:config.expiresAt,
    release:env.CLAUS_NETWORK_RELEASE,configHash:digest(config)},row?.revision??0);
  });
  return result;
 }};
}
