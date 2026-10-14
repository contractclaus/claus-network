import {createDiscovery} from '../src/discovery/index.mjs';
import {createWorkflows} from '../src/workflows/index.mjs';
import {createApps} from '../src/apps/index.mjs';
import {createDeals} from '../src/deals/index.mjs';
import {dealPorts as configuredDealPorts} from './deal-ports.mjs';
import {createContentAdmin} from '../src/content-admin/index.mjs';
import {schemaDefinition,schemaValue} from '../src/services/schema.mjs';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {Pool,neonConfig} from '@neondatabase/serverless';
import ws from 'ws';
import {verifyMessage,createPublicClient,http as rpcHttp} from 'viem';
import {createAccess} from '../src/access/index.mjs';
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
import {createReadonlyChainRouter} from '../adapters/readonly-chain-router.mjs';
import {createChainDeployments} from '../src/chain-deployments/index.mjs';
import {createApprovals} from '../src/approvals/index.mjs';
import {createServices} from '../src/services/index.mjs';
import {createWallets} from '../src/wallets/index.mjs';
import {createWalletRead} from '../adapters/wallet-read.mjs';
import {createReleases} from '../src/releases/index.mjs';
import {createVaults} from '../src/vaults/index.mjs';
import {createVaultRead} from '../adapters/vault-read.mjs';
import {createInference} from '../src/inference/index.mjs';
import {createContractIntake} from '../src/contract-intake/index.mjs';
import {createProjectArchives} from '../src/portability/index.mjs';
import {createProjectTransfers} from '../src/transfers/index.mjs';
import {readonlyPorts} from './readonly-ports.mjs';
import {createSignals} from '../src/signals/index.mjs';
import {createSignalRead,createSignalRouter} from '../adapters/signal-read.mjs';
import {contractIntakeHealth} from './contract-intake-config.mjs';
import {operatorConfig} from './operator-config.mjs';

export function createApplication({store,origin='https://claus.si',rateSalt,now=()=>Date.now(),reviewPorts={},chainPorts={},operatorPorts={},inferencePorts={},intakePorts={},dealPorts={},appStorage=null,appWritesEnabled=true}){
 requireThat(typeof rateSalt==='string'&&rateSalt.length>=32,'rate_salt_required');
 let access,signals;
 const identity=createIdentity({store,limit:(key,reader)=>access.limit(key,reader),consumeProjects:tx=>access.consumeProjects(tx),
  writesEnabled:async reader=>!(await access.policy(reader)).config.paused,domain:new URL(origin).host,now,verifySignature:({address,message,signature})=>verifyMessage({address,message,signature})});
 access=createAccess({store,identity,now,reviewAdmission:reader=>reviewSystem.flow.admission.active(reader),
  managedDiscovery:()=>Promise.all([11155111,1].map(async chainId=>{
   let admission='not_enabled';
   try { await deployments.admission.forChain(chainId,'claus-managed-v1').admitted();admission='public_managed'; }
   catch(error){if(!['chain_public_not_enabled','chain_admission_changed','chain_scope_not_reviewed'].includes(error.code))throw error;}
   return {chainId,profile:'claus-managed-v1',admission};
  })),
  signalDiscovery:()=>Promise.all([11155111,1].map(chainId=>signals.discovery(chainId))),
  intakeDiscovery:()=>Promise.all([11155111,1].map(async chainId=>({chainId,capability:'claus.proposal.create.v1',
   state:await contractIntakeHealth(store,intakePorts,now(),chainId)}))),
  chainAdmission:reader=>deployments.admission.admitted(reader),mainnetAdmission:reader=>deployments.admission.forChain(1).admitted(reader),reviewEligibility:(reader,projectId)=>reviewSystem.flow.admission.eligible(reader,projectId)});
 let services,releases,workflows;
 const artifacts=createArtifactStore({store});
 const contentAdmin=createContentAdmin({store,identity,artifacts,now,origin:operatorPorts.siteOrigin});
 const apps=createApps({storage:appStorage,identity,store,schemaDefinition,schemaValue,now,visible:contentAdmin.visible,admit:access.collaboration,authorizeOperator:contentAdmin.authorize,workflowAuthority:(reader,ref,appId,input)=>workflows.postingAuthority(reader,ref,appId,input),writesEnabled:appWritesEnabled});
 const projects=createProjects({store,identity,now,visible:contentAdmin.visible,visibleMany:contentAdmin.visibleMany,limit:access.limit,consumeSnapshotBytes:access.consumeSnapshotBytes,publicDetails:async projectId=>{
  const [application,publicServices,results,publicReleases,publicSignals]=await Promise.all([
    appStorage?apps.describe(projectId).catch(e=>{if(['not_found','project_unavailable'].includes(e.code))return null;throw e;}):null,
    services.publicForProject(projectId),services.publicResultsForProject(projectId),releases.publicForProject(projectId),signals.publicForProject(projectId)
  ]);
  return {application,services:publicServices,results,releases:publicReleases,signals:publicSignals};
 }});
 let reviewSystem,deployments,approvals,wallets,vaults,inference,intake;
 const jobs=createJobs({store,identity,now,onCancel:async(tx,job)=>{
  await reviewSystem.flow.onCancel(tx,job);await deployments.onCancel(tx,job);await approvals.onCancel(tx,job);await wallets.onCancel(tx,job);
  await vaults.onCancel(tx,job);
  await inference.onCancel(tx,job);
  await intake.onCancel(tx,job);
 }});
 const builds=createBuilds({store,identity,projects,jobs,artifacts,now,limit:access.limit});
 reviewSystem=createReviewSystem({store,identity,projects,builds,jobs,artifacts,now,validatePublicBuild:(artifact,profile)=>chain.validateModule(artifact,profile),selectReviewProfile:(reader,projectId,input)=>deployments.reviewProfile(reader,projectId,input),...reviewPorts});
 const chain=chainPorts.chain??createReadonlyChainRouter({
  sepolia:createChainRead({client:chainPorts.client??createPublicClient({transport:rpcHttp('https://ethereum-sepolia-rpc.publicnode.com',{retryCount:0,timeout:15000})})}),
  mainnet:chainPorts.mainnetClient?createChainRead({client:chainPorts.mainnetClient,chainId:1}):null,
  managedSepolia:createChainRead({client:chainPorts.client??createPublicClient({transport:rpcHttp('https://ethereum-sepolia-rpc.publicnode.com',{retryCount:0,timeout:15000})}),profile:'claus-managed-v1'}),
  managedMainnet:chainPorts.mainnetClient?createChainRead({client:chainPorts.mainnetClient,chainId:1,profile:'claus-managed-v1'}):null
 });
 deployments=createChainDeployments({store,identity,builds,reviews:reviewSystem.flow,jobs,artifacts,chain,now});
 approvals=createApprovals({store,identity,projects,reviews:reviewSystem.flow,deployments,jobs,artifacts,chain,now,signalConsumer:(projectId,reader)=>signals.consumer(projectId,reader)});
 const collaborationAdmission=access.collaboration;
 services=createServices({store,identity,artifacts,limit:access.limit,admit:collaborationAdmission,admitPublicData:access.publicData,now});
 signals=createSignals({store,identity,artifacts,now,publicResult:services.publicResult,chain:chainPorts.signal??createSignalRouter({
  sepolia:createSignalRead({chainId:11155111,client:chainPorts.client??createPublicClient({transport:rpcHttp('https://ethereum-sepolia-rpc.publicnode.com',{retryCount:0,timeout:15000})})}),
  mainnet:chainPorts.mainnetClient?createSignalRead({chainId:1,client:chainPorts.mainnetClient}):null
 })});
 wallets=createWallets({store,identity,jobs,services,now,chain:chainPorts.wallet??createWalletRead({
  client:chainPorts.client??createPublicClient({transport:rpcHttp('https://ethereum-sepolia-rpc.publicnode.com',{retryCount:0,timeout:15000})}),now})});
 requireThat(!operatorPorts.siteOrigin || operatorPorts.siteOrigin !== origin, 'release_origin_not_isolated');
 releases=createReleases({store,identity,projects,artifacts,visible:contentAdmin.visible,limit:access.limit,admit:collaborationAdmission,now,origin:operatorPorts.siteOrigin});
 vaults=createVaults({store,identity,jobs,now,chain:chainPorts.vault??createVaultRead({
  client:chainPorts.client??createPublicClient({transport:rpcHttp('https://ethereum-sepolia-rpc.publicnode.com',{retryCount:0,timeout:15000})})})});
 const archives=operatorPorts.signingKey?createProjectArchives({store,identity,now,...operatorPorts}):null;
 const portabilityAdmission=async reader=>requireThat((await reader.read('network-capabilities','portability'))?.value.enabled===true,'portability_not_enabled');
 const transfers=createProjectTransfers({store,identity,artifacts,archives,now,limit:access.limit,consumeSnapshotBytes:access.consumeSnapshotBytes,admitImport:portabilityAdmission,
  admit:async(projectId,reader)=>{await portabilityAdmission(reader);await collaborationAdmission(projectId,reader);},...operatorPorts});
 inference=createInference({store,identity,jobs,artifacts,now,provider:inferencePorts.provider,
  verifyQuote:inferencePorts.verifyQuote,verifyReceipt:inferencePorts.verifyReceipt,
  enabled:async reader=>inferencePorts.enabled===true&&(await reader.read('network-capabilities','inference'))?.value.enabled===true});
 intake=createContractIntake({store,identity,jobs,now,
  chain:intakePorts.chain??{profile:async()=>{throw Object.assign(Error('contract_intake_disabled'),{code:'contract_intake_disabled'});}},
  createProposal:(actor,projectId,input)=>approvals.create(actor,projectId,input),
  readProposal:async(projectId,id)=>{
   const proposal=(await store.read('chain-proposals',id))?.value;
   requireThat(!proposal||proposal.projectId===projectId,'contract_proposal_mismatch');return proposal??null;
  },
  enabled:async (reader,projectId)=>intakePorts.enabled===true&&
   (intakePorts.verifyAdmission?await intakePorts.verifyAdmission(reader,projectId)===true:
    (await reader.read('network-capabilities','contract-intake'))?.value.enabled===true)});
 workflows=createWorkflows({store,identity,apps,now,admit:access.collaboration});
 const discovery=createDiscovery({store,projects,apps,services,now});
 const deals=createDeals({store,identity,ports:dealPorts});
 const service=createService({deals,workflows,discovery,apps,contentAdmin,access,identity,projects,builds,jobs,reviews:reviewSystem.flow,deployments,approvals,services,wallets,releases,vaults,transfers,inference,intake,signals});
 const admit=async({route,peer})=>{
  if(appStorage?.admit&&(route.startsWith('app_')||route.startsWith('public_app')||route==='mcp'))return appStorage.admit(digest({rateSalt,peer}),now(),(await access.policy()).config);
  return store.transaction(async tx=>{
  const window=Math.floor(now()/300000);
  const group=route.startsWith('auth_')?'auth':'api';
  const limits=(await access.policy(tx)).config;
  for(const [subject,maximum] of [[peer,group==='auth'?limits.authRequestsPerPeer:limits.requestsPerPeer],['global',group==='auth'?limits.authRequestsGlobal:limits.requestsGlobal]]){
   const key=digest({salt:rateSalt,subject,group});
   const old=await tx.read('rate-limits',key);
   const count=old?.value.window===window?old.value.count:0;
   requireThat(count<maximum,'rate_limited');
   await tx.write('rate-limits',key,{window,count:count+1,expiresAt:(window+2)*300000},old?.revision??0);
  }
 });
 };
 const http=createHttp({service,origin,admit}),mcp=createMcp({service,origin,admit});
 return {workflows,discovery,apps,contentAdmin,access,identity,projects,jobs,builds,artifacts,reviewSystem,deployments,approvals,services,wallets,releases,vaults,transfers,inference,intake,signals,service,fetch:(request,context)=>new URL(request.url).pathname==='/mcp'?mcp(request,context):http(request,context)};
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
 const application=createApplication({store,origin,rateSalt:process.env.CLAUS_NETWORK_RATE_SALT,operatorPorts:operatorConfig(),chainPorts:readonlyPorts(),dealPorts:configuredDealPorts()});
 const server=await listen(application,{port:Number(process.env.PORT??8787)});
 console.log('Claus Network listening on '+server.address().address+':'+server.address().port);
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(async()=>{await store.close();process.exit(0);}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.code??'startup_failed');process.exitCode=1;});
