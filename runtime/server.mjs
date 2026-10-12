import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {Pool,neonConfig} from '@neondatabase/serverless';
import ws from 'ws';
import {verifyMessage,createPublicClient,http as rpcHttp} from 'viem';
import {createIdentity} from '../src/identity/index.mjs';
import {createProjects} from '../src/projects/index.mjs';
import {createJobs} from '../src/jobs/index.mjs';
import {createArtifactStore} from '../src/artifact-store/index.mjs';
import {createBuilds} from '../src/builds/index.mjs';
import {openStore} from '../src/storage/index.mjs';
import {openPostgresStore} from '../src/postgres/index.mjs';
import {createService} from '../interfaces/service.mjs';
import {createHttp} from '../interfaces/http.mjs';
import {createMcp} from '../interfaces/mcp.mjs';
import {digest,requireThat} from '../src/shared/index.mjs';
import {createReviewSystem} from './reviews.mjs';
import {createChainRead} from '../adapters/chain-read.mjs';
import {createChainDeployments} from '../src/chain-deployments/index.mjs';
import {createApprovals} from '../src/approvals/index.mjs';
import {createServices} from '../src/services/index.mjs';
import {createWallets} from '../src/wallets/index.mjs';
import {createWalletRead} from '../adapters/wallet-read.mjs';
import {createReleases} from '../src/releases/index.mjs';
import {createVaults} from '../src/vaults/index.mjs';
import {createVaultRead} from '../adapters/vault-read.mjs';

export function createApplication({store,origin='https://claus.si',rateSalt,now=()=>Date.now(),reviewPorts={},chainPorts={}}){
 requireThat(typeof rateSalt==='string'&&rateSalt.length>=32,'rate_salt_required');
 const identity=createIdentity({store,domain:new URL(origin).host,now,verifySignature:({address,message,signature})=>verifyMessage({address,message,signature})});
 let services,releases;
 const projects=createProjects({store,identity,now,publicDetails:async projectId=>({
  services:await services.publicForProject(projectId),releases:await releases.publicForProject(projectId)
 })});
 let reviewSystem,deployments,approvals,wallets,vaults;
 const jobs=createJobs({store,identity,now,onCancel:async(tx,job)=>{
  await reviewSystem.flow.onCancel(tx,job);await deployments.onCancel(tx,job);await approvals.onCancel(tx,job);await wallets.onCancel(tx,job);
  await vaults.onCancel(tx,job);
 }});
 const artifacts=createArtifactStore({store});
 const builds=createBuilds({store,identity,projects,jobs,artifacts,now});
 reviewSystem=createReviewSystem({store,identity,projects,builds,jobs,artifacts,now,...reviewPorts});
 const chain=chainPorts.chain??createChainRead({client:chainPorts.client??createPublicClient({transport:rpcHttp('https://ethereum-sepolia-rpc.publicnode.com',{retryCount:0,timeout:15000})})});
 deployments=createChainDeployments({store,identity,builds,reviews:reviewSystem.flow,jobs,artifacts,chain,now});
 approvals=createApprovals({store,identity,projects,reviews:reviewSystem.flow,deployments,jobs,artifacts,chain,now});
 const collaborationAdmission=async(projectId,reader)=>{
  const cap=(await reader.read('network-capabilities','collaboration'))?.value;
  const pilot=(await reader.read('review-pilots',projectId))?.value;
  requireThat(cap?.enabled===true,'collaboration_not_enabled');
  requireThat(pilot?.enabled===true&&pilot.expiresAt>now(),'sponsor_not_enabled');
 };
 services=createServices({store,identity,artifacts,admit:collaborationAdmission,now});
 wallets=createWallets({store,identity,jobs,services,now,chain:chainPorts.wallet??createWalletRead({
  client:chainPorts.client??createPublicClient({transport:rpcHttp('https://ethereum-sepolia-rpc.publicnode.com',{retryCount:0,timeout:15000})}),now})});
 releases=createReleases({store,identity,projects,artifacts,admit:collaborationAdmission,now});
 vaults=createVaults({store,identity,jobs,now,chain:chainPorts.vault??createVaultRead({
  client:chainPorts.client??createPublicClient({transport:rpcHttp('https://ethereum-sepolia-rpc.publicnode.com',{retryCount:0,timeout:15000})})})});
 const service=createService({identity,projects,builds,jobs,reviews:reviewSystem.flow,deployments,approvals,services,wallets,releases,vaults});
 const admit=async({route,peer})=>store.transaction(async tx=>{
  const window=Math.floor(now()/300000);
  const group=route.startsWith('auth_')?'auth':'api';
  for(const [subject,maximum] of [[peer,group==='auth'?30:300],['global',group==='auth'?200:3000]]){
   const key=digest({salt:rateSalt,subject,group});
   const old=await tx.read('rate-limits',key);
   const count=old?.value.window===window?old.value.count:0;
   requireThat(count<maximum,'rate_limited');
   await tx.write('rate-limits',key,{window,count:count+1,expiresAt:(window+2)*300000},old?.revision??0);
  }
 });
 const http=createHttp({service,origin,admit}),mcp=createMcp({service,origin,admit});
 return {identity,projects,jobs,builds,artifacts,reviewSystem,deployments,approvals,services,wallets,releases,vaults,service,fetch:(request,context)=>new URL(request.url).pathname==='/mcp'?mcp(request,context):http(request,context)};
}
export function listen(application,{host='127.0.0.1',port=0}={}){
 const server=createServer(async(req,res)=>{
  const controller=new AbortController();req.on('aborted',()=>controller.abort());
  try{
   const request=new Request('http://localhost'+req.url,{method:req.method,headers:req.headers,
    ...(req.method==='GET'||req.method==='HEAD'?{}:{body:req,duplex:'half'}),signal:controller.signal});
   const response=await application.fetch(request,{peer:req.socket.remoteAddress});
   res.writeHead(response.status,Object.fromEntries(response.headers));
   res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"service_unavailable"}');}
 });
 return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>resolve(server));});
}
async function main(){
 const origin=process.env.CLAUS_NETWORK_ORIGIN??'https://claus.si';
 let store;
 if(process.env.CLAUS_NETWORK_DATABASE_URL){
  neonConfig.webSocketConstructor=ws;
  store=await openPostgresStore({pool:new Pool({connectionString:process.env.CLAUS_NETWORK_DATABASE_URL,max:6,connectionTimeoutMillis:10000}),schema:'claus_network'});
 }else{
  requireThat(process.env.CLAUS_NETWORK_LOCAL==='1','database_required');
  store=openStore(process.env.CLAUS_NETWORK_LOCAL_FILE??'network-local.sqlite');
 }
 const application=createApplication({store,origin,rateSalt:process.env.CLAUS_NETWORK_RATE_SALT});
 const server=await listen(application,{port:Number(process.env.PORT??8787)});
 console.log('Claus Network listening on '+server.address().address+':'+server.address().port);
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(async()=>{await store.close();process.exit(0);}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.code??'startup_failed');process.exitCode=1;});
