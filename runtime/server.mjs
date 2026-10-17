import {createRuntimeReleases,RUNTIME_IMAGE_PROFILE,validateRuntimeBuild} from '../src/infrastructure/runtime-release.mjs';
import {createImageRegistry} from '../src/infrastructure/registry.mjs';
import {createOciBuilds} from '../src/infrastructure/builds.mjs';
import {createInfrastructure} from '../src/infrastructure/index.mjs';
import {PROFILE as PARTNER_PROFILE} from '../src/partner-launch/policy.mjs';
import {createPartnerLaunches} from '../src/partner-launch/index.mjs';
import {PROFILE as CAPITAL_PROFILE} from '../src/capital/policy.mjs';
import {selectCapitalReview,validateCapitalBuild} from '../src/capital/review.mjs';
import { NATIVE_PROGRAM_PROFILE, selectNativeProgramReview, validateNativeProgramBuild } from '../src/review-flow/native-program.mjs';
import {publicWebRead} from './public-web-read.mjs';
import {ROUTES,validate} from '../interfaces/contract.mjs';
import {createWebhooks} from '../src/webhooks/index.mjs';
import {deliverWebhook} from './webhook-delivery.mjs';
import {createHmac} from 'node:crypto';
import {createWorkPlanning} from '../src/work-planning/index.mjs';
import {renderTemplate} from './app-template-page.mjs';
import {createCollaboration,createDependencies,createProjectInspection} from '../src/collaboration/index.mjs';
import {createArbitration} from '../src/deals/arbitration.mjs';
import {createWorkers} from '../src/workers/index.mjs';
import {createDomains} from '../src/domains/index.mjs';
import {createDiscovery} from '../src/discovery/index.mjs';
import {createWorkflows} from '../src/workflows/index.mjs';
import serviceProgram from '../src/application/source.json' with {type:'json'};
import {createApps} from '../src/apps/index.mjs';
import {createDeals} from '../src/deals/index.mjs';
import {createTaskPayments} from '../src/deals/task-payments.mjs';
import {createContentAdmin} from '../src/content-admin/index.mjs';
import {schemaDefinition,schemaValue} from '../src/services/schema.mjs';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {verifyMessage,createPublicClient,http as rpcHttp} from 'viem';
import {createAccess} from '../src/access/index.mjs';
import {createIdentity} from '../src/identity/index.mjs';
import {createProjects} from '../src/projects/index.mjs';
import {createWorkConnections} from '../src/collaboration/connections.mjs';
import {createJobs} from '../src/jobs/index.mjs';
import {createDataFiles} from '../src/data-files/index.mjs';
import {createArtifactStore,createSourceFiles} from '../src/artifact-store/index.mjs';
import {createBuilds} from '../src/builds/index.mjs';
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
import {createRuntimes} from '../src/runtimes/index.mjs';
import {createComputeControl} from '../src/inference/control.mjs';
import {createInference} from '../src/inference/index.mjs';
import {createContractIntake} from '../src/contract-intake/index.mjs';
import {createProjectArchives} from '../src/portability/index.mjs';
import {createProjectTransfers} from '../src/transfers/index.mjs';
import {createSignals} from '../src/signals/index.mjs';
import {createSignalRead,createSignalRouter} from '../adapters/signal-read.mjs';
import {contractIntakeHealth} from './contract-intake-config.mjs';
import {createPublicAppearances} from '../src/releases/appearance.mjs';

export function createApplication({dataObjects=null,registryOrigin='https://claus-network-api.vercel.app',imageArchive=null,ociBuildPorts={},ociBuildEnabled=false,infrastructurePorts={},infrastructureEnabled=false,sourceObjects=null,store,origin='https://claus.si',rateSalt,now=()=>Date.now(),reviewPorts={},chainPorts={},operatorPorts={},inferencePorts={},intakePorts={},dealPorts={},arbitrationEnabled=false,domainPorts={},domainsEnabled=false,workersEnabled=false,workerPorts={},appStorage=null,appWritesEnabled=true,partnerLaunchAssignment=process.env.CLAUS_PARTNER_LAUNCH_ASSIGNMENT}){
 requireThat(typeof rateSalt==='string'&&rateSalt.length>=32,'rate_salt_required');
 let access,signals;
 const identity=createIdentity({store,limit:(key,reader)=>access.limit(key,reader),consumeProjects:tx=>access.consumeProjects(tx),
  writesEnabled:async reader=>!(await access.policy(reader)).config.paused,domain:new URL(origin).host,now,verifySignature:({address,message,signature})=>verifyMessage({address,message,signature})});
 access=createAccess({store,identity,now,inferenceDiscovery:()=>inference.discovery(),reviewAdmission:reader=>reviewSystem.flow.admission.active(reader),
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
 const dataFiles=createDataFiles({store,identity,objects:dataObjects,now});
 const artifacts=createArtifactStore({store}),sourceFiles=createSourceFiles({store,objects:sourceObjects,now});
 const contentAdmin=createContentAdmin({store,identity,artifacts,sourceFiles,now,origin:operatorPorts.siteOrigin});
 const arbitration=createArbitration({store,identity,dealPorts,now,enabled:arbitrationEnabled});
 const deals=createDeals({store,identity,ports:dealPorts});
 const taskPayments=createTaskPayments({identity,store,ports:dealPorts,deals,evidence:arbitration.evidence,now});
 const apps=createApps({serviceProgram:()=>serviceProgram,taskPayments,storage:appStorage,identity,store,schemaDefinition,schemaValue,now,visible:contentAdmin.visible,admit:access.collaboration,authorizeOperator:contentAdmin.authorize,workflowAuthority:(reader,ref,appId,input)=>workflows.postingAuthority(reader,ref,appId,input),writesEnabled:appWritesEnabled});
 const projects=createProjects({store,identity,sourceFiles,now,visible:contentAdmin.visible,visibleMany:contentAdmin.visibleMany,publicAppearances:createPublicAppearances({store,sourceFiles,visibleMany:contentAdmin.visibleMany,now}),publicConnections:createWorkConnections({store,apps,visible:contentAdmin.visible}),limit:access.limit,consumeSnapshotBytes:access.consumeSnapshotBytes,publicAppearance:async projectId=>({releases:await releases.publicForProject(projectId)}),publicEntry:async projectId=>{
  const [application,publicReleases]=await Promise.all([
    appStorage?apps.describe(projectId).catch(e=>{if(['not_found','project_unavailable'].includes(e.code))return null;throw e;}):null,
    releases.publicForProject(projectId)
  ]);return {application,releases:publicReleases};
 },publicDetails:async projectId=>{
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
 const partnerLaunches=createPartnerLaunches({store,identity,builds,artifacts,sourceFiles,pins:partnerLaunchAssignment,now});
 const runtimeReleases=createRuntimeReleases({store,identity,projects,artifacts,origin:registryOrigin,now});
 reviewSystem=createReviewSystem({store,identity,projects,builds,jobs,artifacts,now,partnerLaunches,runtimeReleases,validatePublicBuild:(artifact,profile)=>profile===RUNTIME_IMAGE_PROFILE?validateRuntimeBuild(artifact):[CAPITAL_PROFILE,PARTNER_PROFILE].includes(profile)?validateCapitalBuild(artifact):profile===NATIVE_PROGRAM_PROFILE?validateNativeProgramBuild(artifact):chain.validateModule(artifact,profile),selectReviewProfile:(reader,projectId,input)=>input.profile===RUNTIME_IMAGE_PROFILE?runtimeReleases.select(reader,projectId,input):input.profile===PARTNER_PROFILE?partnerLaunches.select(reader,projectId,input):input.profile===CAPITAL_PROFILE?selectCapitalReview({reader,identity,projectId,...input}):input.profile===NATIVE_PROGRAM_PROFILE?selectNativeProgramReview({reader,identity,projectId,...input}):deployments.reviewProfile(reader,projectId,input),...reviewPorts});
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
 releases=createReleases({sourceFiles,appSchema:async(projectId)=>{if(!appStorage)return null;const a=(await appStorage.reader(projectId).read('meta','app'))?.value;return a?digest(a.manifest):null;},store,identity,projects,artifacts,visible:contentAdmin.visible,limit:access.limit,admit:collaborationAdmission,now,origin:operatorPorts.siteOrigin});
 vaults=createVaults({store,identity,jobs,now,chain:chainPorts.vault??createVaultRead({
  client:chainPorts.client??createPublicClient({transport:rpcHttp('https://ethereum-sepolia-rpc.publicnode.com',{retryCount:0,timeout:15000})})})});
 const archives=operatorPorts.signingKey?createProjectArchives({store,identity,sourceFiles,now,...operatorPorts}):null;
 const portabilityAdmission=async reader=>requireThat((await reader.read('network-capabilities','portability'))?.value.enabled===true,'portability_not_enabled');
 const transfers=createProjectTransfers({store,identity,artifacts,archives,now,limit:access.limit,consumeSnapshotBytes:access.consumeSnapshotBytes,admitImport:portabilityAdmission,
  admit:async(projectId,reader)=>{await portabilityAdmission(reader);await collaborationAdmission(projectId,reader);},...operatorPorts});
 const compute=createComputeControl({store,identity,now});
 inference=createInference({store,identity,jobs,artifacts,now,profileEnabled:compute.active,provider:inferencePorts.provider,
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
 const domains=createDomains({store,identity,releases,now,ports:domainPorts,enabled:domainsEnabled});
 const ociBuilds=createOciBuilds({store,identity,projects,jobs,artifacts,images:imageArchive,now,ports:ociBuildPorts,enabled:ociBuildEnabled});
 const imageRegistry=createImageRegistry({store,identity,projects,artifacts,images:imageArchive,origin:registryOrigin,now});
 const infrastructure=createInfrastructure({store,identity,projects,now,ports:infrastructurePorts,enabled:infrastructureEnabled});
 const workers=createWorkers({store,identity,projects,artifacts,now,ports:workerPorts,enabled:workersEnabled});
 const collaboration=createCollaboration({renderTemplate,store,identity,apps,visible:contentAdmin.visible,admit:access.collaboration,now});
 const dependencies=createDependencies({store,identity,visible:contentAdmin.visible,admit:access.collaboration,now});
 const projectInspection=createProjectInspection({projects,releases,dependencies,actions:id=>workPlanning.actions(id),now});
 const publicWork=async({after='',limit=20})=>{const url=new URL('https://claus-agent.vercel.app/public/network-work');url.searchParams.set('limit',String(limit));if(after)url.searchParams.set('after',after);const r=await fetch(url,{signal:AbortSignal.timeout(8000),redirect:'error'});requireThat(r.ok,'public_work_unavailable');const body=await r.text();requireThat(body.length<100000,'public_work_unavailable');const data=JSON.parse(body);requireThat(Array.isArray(data.items),'public_work_unavailable');return data;};
 const workPlanning=createWorkPlanning({store,identity,apps,collaboration,services,projects,visible:contentAdmin.visible,admit:access.collaboration,validateAction:(name,input,path)=>validate(ROUTES.find(r=>r.name===name).inputSchema,input,path),now});
 const webhooks=createWebhooks({store,identity,apps,admit:access.collaboration,now,deriveSecret:id=>createHmac('sha256',rateSalt).update('claus-webhook/v1:'+id).digest('hex'),deliver:deliverWebhook});
 const runtimes=createRuntimes({store,identity,workers,readWeb:publicWebRead,now,route:name=>ROUTES.find(r=>r.name===name),execute:(name,input,actor)=>service.executeAs(name,input,actor)});
 const service=createService({dataFiles,runtimeReleases,imageRegistry,ociBuilds,infrastructure,partnerLaunches,runtimes,compute,webhooks,workPlanning,dependencies,projectInspection,publicWork,collaboration,arbitration,workers,domains,deals,workflows,discovery,apps,contentAdmin,access,identity,projects,builds,jobs,reviews:reviewSystem.flow,deployments,approvals,services,wallets,releases,vaults,transfers,inference,intake,signals});
 const admit=async({route,peer})=>{
  const at=now(),window=Math.floor(at/300000);
  try {
   const limits=(await access.policy()).config;
   if(appStorage?.admit&&(route.startsWith('app_')||route.startsWith('public_app')||route==='mcp'))return await appStorage.admit(digest({rateSalt,peer}),at,limits);
   const group=route.startsWith('auth_')?'auth':'api';
   const entries=[['global',group==='auth'?limits.authRequestsGlobal:limits.requestsGlobal],[peer,group==='auth'?limits.authRequestsPerPeer:limits.requestsPerPeer]]
    .map(([subject,maximum])=>({id:digest({salt:rateSalt,subject,group}),maximum}));
   if(store.consumeRateLimits)return await store.consumeRateLimits({entries,window});
   return await store.transaction(async tx=>{
    for(const {id,maximum} of entries){
     const old=await tx.read('rate-limits',id),count=old?.value.window===window?old.value.count:0;
     requireThat(count<maximum,'rate_limited');
     await tx.write('rate-limits',id,{window,count:count+1,expiresAt:(window+2)*300000},old?.revision??0);
    }
   });
  } catch(error) {
   if(error.code==='rate_limited')error.retryAfterSeconds=Math.max(1,Math.ceil(((window+1)*300000-now())/1000));
   throw error;
  }
 };
 const http=createHttp({service,origin,admit}),mcp=createMcp({service,origin,admit});
 return {dataFiles,runtimeReleases,sourceFiles,ociBuilds,infrastructure,partnerLaunches,runtimes,compute,webhooks,arbitration,workers,domains,workflows,discovery,apps,contentAdmin,access,identity,projects,jobs,builds,artifacts,reviewSystem,deployments,approvals,services,wallets,releases,vaults,transfers,inference,intake,signals,service,fetch:async(request,context={})=>{const path=new URL(request.url).pathname;if(path==='/v2'||path.startsWith('/v2/')){try{await admit({route:'resource_image_registry',peer:context.peer??'unknown'});return await imageRegistry.handle(request);}catch(error){return new Response(null,{status:error.code==='rate_limited'?429:503,headers:{'cache-control':'no-store',...(error.retryAfterSeconds?{'retry-after':String(error.retryAfterSeconds)}:{})}});}}return path==='/mcp'?mcp(request,context):http(request,context);}};
}
export function listen(application,{host='127.0.0.1',port=0}={}){
 const server=createServer(async(req,res)=>{
  const controller=new AbortController();req.on('aborted',()=>controller.abort());res.once('close',()=>controller.abort());
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
export async function startRuntimeServer({env=process.env}={}){
 const [{openRuntime},{runtimeHealth}]=await Promise.all([import('./bootstrap.mjs'),import('./health.mjs')]);
 const runtime=await openRuntime({env,allowLocal:true});
 let server;
 try{
  server=await listen({fetch:(request,context)=>new URL(request.url).pathname==='/health'&&['GET','HEAD'].includes(request.method)?runtimeHealth(runtime,env):runtime.app.fetch(request,context)},
   {host:env.HOST??'0.0.0.0',port:Number(env.PORT??8787)});
 }catch(error){await runtime.close();throw error;}
 server.requestTimeout=60000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
 let closing;
 const close=()=>closing??=(async()=>{
  const forced=setTimeout(()=>server.closeAllConnections(),15000);forced.unref();
  try{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  finally{clearTimeout(forced);await runtime.close();}
 })();
 return {server,close};
}
async function main(){
 const runtime=await startRuntimeServer();
 console.log('Claus Network listening on '+runtime.server.address().address+':'+runtime.server.address().port);
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{runtime.close().then(()=>{process.exitCode=0;},()=>{process.exitCode=1;});});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.code??'startup_failed');process.exitCode=1;});
