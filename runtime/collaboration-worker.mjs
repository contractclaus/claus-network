import {Pool,neonConfig} from '@neondatabase/serverless';
import ws from 'ws';
import {createPublicClient,http} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {openPostgresStore} from '../src/postgres/index.mjs';
import {createApplication} from './server.mjs';
import {createServiceConformance} from './service-conformance.mjs';
import {createWalletRead} from '../adapters/wallet-read.mjs';
import {createWalletExecutor} from '../adapters/wallet-executor.mjs';
import {createSealer} from '../adapters/secrets.mjs';
import {createSourceVerification} from '../adapters/source-verification.mjs';
import {requireThat} from '../src/shared/index.mjs';

export async function createCollaborationWorker(role,env=process.env){
  requireThat(['services','wallets'].includes(role),'invalid_worker_role');
  neonConfig.webSocketConstructor=ws;
  const store=await openPostgresStore({pool:new Pool({connectionString:env.CLAUS_NETWORK_DATABASE_URL,max:3,connectionTimeoutMillis:8000})});
  const client=createPublicClient({transport:http('https://ethereum-sepolia-rpc.publicnode.com',{retryCount:0,timeout:15000})});
  const chain=createWalletRead({client});
  const app=createApplication({store,origin:env.CLAUS_NETWORK_ORIGIN,rateSalt:env.CLAUS_NETWORK_RATE_SALT,chainPorts:{client,wallet:chain}});
  const services=createServiceConformance({store,services:app.services});
  const signer=role==='wallets'?privateKeyToAccount(env.CLAUS_CHAIN_PRIVATE_KEY):null;
  const executor=role==='wallets'?createWalletExecutor({store,client,signer,chain,artifacts:app.artifacts,
    sealer:createSealer(env.CLAUS_NETWORK_SEALING_KEY),verification:createSourceVerification({store,etherscanKey:env.ETHERSCAN_API_KEY})}):null;
  return{store,async tick(){
    const cap=(await store.read('network-capabilities',role==='wallets'?'wallets':'collaboration'))?.value;
    if(cap?.enabled!==true)return{state:'disabled'};
    if(signer)requireThat(cap.executorPayer?.toLowerCase()===signer.address.toLowerCase()&&
      env.CLAUS_CHAIN_SIGNER?.toLowerCase()===signer.address.toLowerCase(),'worker_role_mismatch');
    const result=role==='wallets'?await app.wallets.runOne(executor):await services.tick();
    await store.transaction(async tx=>{
      const old=await tx.read('worker-health',role);
      await tx.write('worker-health',role,{state:result.state??'ready',observedAt:Date.now(),release:env.CLAUS_NETWORK_RELEASE},old?.revision??0);
    });
    return{state:result.state??'ready'};
  }};
}
