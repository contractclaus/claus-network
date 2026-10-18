import {databasePermit} from './database-fence.js';
import {browserDownloadRoute} from './external/browser-downloads.js';
import {developmentToolsRoute} from './external/development-bridge.js';
import {managedSchemaReady} from './database-schema.js';
import {isolatedHealth} from './isolated/bridge.js';
import {publicWork,networkCare} from './network-care.js';
import {labInference} from './lab-model.js';
import {surfaceStore,monitorSurface} from './surface/service.js';
import {SurfaceHost} from './surface/host.js';
import {initialSource,sourceHash} from './surface/source.js';
import {enqueueNetworkRelease,withdrawNetworkRelease,networkReleaseFeed} from './network-releases.js';
import {gotchiStore} from './gotchi/service.js';
import {feedbackBuildStore} from './feedback-builds.js';
import {adaptationStore,adaptationTool} from './adaptation-service.js';
import {publicSiteManifest} from './site/schema.js';
import {packageAction,packageStore} from './workspaces/package-service.js';
import {continuityStore} from './workspaces/continuity-service.js';
import {contributionStore} from './workspaces/review-service.js';
import {workspaceAction} from './workspaces/service.js';
import {siteStore,siteTool,siteFeatureStore} from './site/service.js';
import {labStore,publicLab,tickResearch,currentLab,researchExtensions,labPublicContext} from './lab-service.js';
import {builderStore,readBuilder,builderTick} from './builder-service.js';
import {startBuilder,recoverBuilder} from './builder-life.js';
import {buildRuntime,builderRuntimeEnabled} from './builder-schema.js';
import {builderSandboxHealth} from './builder-sandbox.js';
import {requireCurrentLabState} from './lab-publication.js';
import {upgradeGeneration,resumeGeneration} from './runtime-upgrade.js';
import {ownerRuntimeHandoff,readRuntimeHandoff} from './operations/runtime-handoff.js';
import {OperationsHost} from './operations/host.js';
import {productionLabDatabase} from './lab-db.js';
import {startResearch,researchLife} from './lab-life.js';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import {exportBackupCheckpoint} from './backup.js';
import { start } from 'workflow/api';
import { life,clubWake } from './life.js';
import {wakeClub} from './club-wake.js';
import * as store from './store.js';
import {createHash as databaseBindingHash} from 'node:crypto';
const storeBindingHash=(value:string)=>databaseBindingHash('sha256').update(value).digest('hex');
import { authorized } from './config.js';
import { modelReady } from './model.js';
import { verifyX, xReady } from './x.js';
import { recall, archiveOverview } from './archive.js';
import { readReference, referenceOverview } from './reference.js';
import { operationalOverview } from './overview.js';
import {uniswapRequest} from './uniswap.js';
import {prepareRelease} from './release.js';
import {assignMission,activeMissions,hasWriteMission} from './missions.js';
import {publicState,publicMetadata,publicJournal,publishUpdate,publicationFactsHash} from './public.js';
import {replyDeliveryOverview} from './social.js';
import {executeTool} from './tools.js';
import {workWallet} from './work-wallet.js';
import {operatorAttention,reviewSecurityReport} from './operator-attention.js';
import {publicXPosts} from './public-x.js';
import {recoveryCandidate} from './recovery.js';
import {readKnowledgeResolved,knowledgeAudit} from './knowledge.js';
import {inferenceBindings} from './inference-bindings.js';
import {networkReviewRoutes} from './network-review-routes.js';
import {networkOperations,networkOperationsEnabled} from './network-operations.js';

const app=new Hono();
app.get('/internal/browser-download',c=>browserDownloadRoute(c.req.raw));
app.post('/internal/development/tools',c=>developmentToolsRoute(c.req.raw));
app.route('/internal/network',networkReviewRoutes);
app.get('/public/lab/:view',async c=>{const view=c.req.param('view');if(!['feed','ideas'].includes(view))return c.json({error:'not_found'},404);const limit=Number(c.req.query('limit')??20);if(!Number.isInteger(limit)||limit<1||limit>50)return c.json({error:'invalid_limit'},400);const data=await publicLab(view,{after:c.req.query('after'),before:c.req.query('before'),id:c.req.query('idea'),limit});c.header('Cache-Control','no-store');return data?c.json(data):c.json({error:'not_available'},404);});
app.get('/public/lab/ideas/:id',async c=>{const data=await publicLab('idea',{id:c.req.param('id')});c.header('Cache-Control','no-store');return data?c.json(data):c.json({error:'not_found'},404);});
app.get('/public/network-work',async c=>{try{c.header('Cache-Control','public,max-age=0,s-maxage=10');return c.json(await publicWork({after:c.req.query('after'),limit:Number(c.req.query('limit')??20)}));}catch{return c.json({error:'work_unavailable'},503);}});
app.get('/public/network-updates',async c=>{c.header('Cache-Control','public,max-age=0,s-maxage=10');return c.json({releases:await networkReleaseFeed(true)});});
app.get('/public/posts',async c=>{
  try {const feed=await publicXPosts();c.header('Cache-Control','public,max-age=0,s-maxage=15');return c.json(feed);}
  catch {c.header('Cache-Control','no-store');return c.json({error:'posts_unavailable'},503);}
});
app.get('/public/extensions',async c=>{const s=await siteStore().current();c.header('Cache-Control','public,max-age=0,s-maxage=10');return c.json({revision:s.revision,enabled:s.enabled,manifest:publicSiteManifest(s.enabled?s.manifest:await siteStore().version(0)),updatedAt:s.updatedAt});});
app.get('/public/state',async c=>{c.header('Cache-Control','no-store');return c.json(await publicState());});
app.get('/public/journal/:id',async c=>{c.header('Cache-Control','no-store');const entry=await publicJournal(c.req.param('id'));return entry?c.json(entry):c.json({error:'not_found'},404);});
app.get('/public/metadata/:hash',async c=>{const data=await publicMetadata(c.req.param('hash').replace(/\.json$/,''));if(!data)return c.json({error:'not_found'},404);c.header('Cache-Control','public,max-age=31536000,immutable');return c.body(data,200,{'Content-Type':'application/json; charset=utf-8'});});
app.get('/public/network-surface',async c=>{c.header('Cache-Control','public,max-age=20');try{const r=await surfaceStore().publicRelease(c.req.query('id'));return r?c.json(r):c.json({enabled:false},404);}catch{return c.json({enabled:false},503);}});
app.get('/health',async c=>{
  await managedSchemaReady();
  const published=process.env.DATABASE_URL?await publicState():null;
  return c.json({isolatedAnalysis:await isolatedHealth(),service:'claus-agent',coin:published?.token.address?'published_deployment':'not_published',tokenAddress:published?.token.address??null,databaseConfigured:!!process.env.DATABASE_URL,inferenceConfigured:modelReady(),xConfigured:xReady(),contractLabConfigured:!!process.env.LAB_SNAPSHOT_ID,uniswapApiConfigured:!!process.env.UNISWAP_API_KEY,programmableApiConfigured:!!process.env.PROGRAMMABLE_API_KEY});
});
app.use('/api/*',async(c,next)=>{
  c.header('Cache-Control','no-store');
  const secret=(c.req.path==='/api/site/club'||c.req.path==='/api/club/wake'||c.req.path==='/api/workspaces'||c.req.path==='/api/packages')?process.env.CLUB_AGENT_SECRET:c.req.path==='/api/backup/checkpoint'?process.env.BACKUP_SECRET:['/api/recover','/api/lab/recover','/api/builder/recover'].includes(c.req.path)?process.env.CRON_SECRET:c.req.path==='/api/wallet-policy'?process.env.WALLET_POLICY_SECRET:process.env.OPERATOR_SECRET;
  if(!authorized(c.req.header('authorization'),secret)) return c.json({error:'unauthorized'},401);
  if(Number(c.req.header('content-length')??0)>(c.req.path==='/api/config'?256000:c.req.path==='/api/workspaces'?150000:100000)) return c.json({error:'request_too_large'},413);
  await next();
});
app.get('/api/database-identity',async c=>c.json({instance:process.env.NATIVE_DATABASE_INSTANCE??null,allowed:await databasePermit(),bindingHash:storeBindingHash(process.env.DATABASE_URL??'')}));
app.post('/api/external-tools',async c=>{const id=c.req.header('idempotency-key');if(!id||!/^[-a-zA-Z0-9_:]{1,160}$/.test(id))return c.json({error:'idempotency_key_required'},400);const raw=await c.req.text();if(Buffer.byteLength(raw)>32000)return c.json({error:'request_too_large'},413);try{return c.json(await executeTool(id,'external_tools',JSON.parse(raw)));}catch(e){return c.json({error:e instanceof Error?e.message:'external_tool_unavailable'},409);}});
app.post('/api/network-care',async c=>{try{if(!networkOperationsEnabled(await store.configuration()))return c.json({error:'disabled'},403);return c.json(await networkCare(await c.req.json()));}catch(e){return c.json({error:e instanceof Error?e.message:'unavailable'},409);}});
app.get('/api/network-releases',async c=>c.json({releases:await networkReleaseFeed()}));
app.post('/api/network-releases',async c=>{try{const raw=await c.req.text();if(Buffer.byteLength(raw)>16000)return c.json({error:'request_too_large'},413);return c.json(await enqueueNetworkRelease(JSON.parse(raw)),201);}catch(e){return c.json({error:e instanceof Error?e.message:'network_release_invalid'},400);}});
app.post('/api/network-releases/:id/withdraw',async c=>{try{return c.json(await withdrawNetworkRelease(c.req.param('id')));}catch{return c.json({error:'network_release_not_queued'},409);}});
app.post('/api/workspaces',async c=>{
 const raw=await c.req.text();if(Buffer.byteLength(raw)>150000)return c.json({error:'builder_request_too_large'},413);
 try{const v=JSON.parse(raw);return c.json(await workspaceAction(v.owner,v.action,v.input,c.req.header('idempotency-key'),v.seatCandidates));}
 catch(e){const message=e instanceof Error?e.message:'';return c.json({error:/^builder_[a-z_]+$/.test(message)?message:'builder_unavailable'},/^builder_[a-z_]+$/.test(message)?409:503);}
});
app.post('/api/packages',async c=>{
 const raw=await c.req.text();if(Buffer.byteLength(raw)>8000)return c.json({error:'package_request_too_large'},413);
 try{const v=JSON.parse(raw);if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['owner','username','action','input'].includes(k)))return c.json({error:'package_request_invalid'},400);return c.json(await packageAction(v.owner,v.username,v.action,v.input,c.req.header('idempotency-key')));}
 catch(e){const message=e instanceof Error?e.message:'';return c.json({error:/^package_[a-z_]+$/.test(message)?message:'package_unavailable'},message==='package_missing'?404:/^package_[a-z_]+$/.test(message)?409:503);}
});
// Emergency removal uses operator authentication, never a public author or model grant.
app.post('/api/packages/withdraw',async c=>{
 try{const v=await c.req.json();if(!v||Object.keys(v).some(k=>!['owner','packageId'].includes(k)))return c.json({error:'package_request_invalid'},400);return c.json(await packageAction(v.owner,null,'withdraw',{packageId:v.packageId},c.req.header('idempotency-key')));}
 catch(e){const message=e instanceof Error?e.message:'';return c.json({error:/^package_[a-z_]+$/.test(message)?message:'package_unavailable'},/^package_[a-z_]+$/.test(message)?409:503);}
});
app.post('/api/club/wake',async c=>c.json(await wakeClub(async(generation,ticket)=>(await start(clubWake,[generation,ticket])).runId),202));
app.post('/api/builder/setup',async c=>{await adaptationStore().initialize();await builderStore().initialize();await feedbackBuildStore().initialize();await siteStore().initialize();await siteFeatureStore().initialize();await contributionStore().initialize();await packageStore().initialize();await continuityStore().initialize();return c.json({initialized:true});});
app.post('/api/gotchi/setup',async c=>{await gotchiStore().initialize();return c.json({initialized:true,activated:false});});
app.get('/api/site/club',async c=>{const state=await siteStore().current();return c.json({revision:state.revision,enabled:state.enabled,updatedAt:state.updatedAt,manifest:{...state.manifest,pages:state.enabled?state.manifest.pages.filter(p=>p.placement==='club'):[]}});});
app.get('/api/adaptation',async c=>c.json({...await adaptationStore().current(),history:await adaptationStore().history()}));
app.post('/api/adaptation/control',async c=>{const body=await c.req.json();if(!body||typeof body.enabled!=='boolean'||Object.keys(body).length!==1)return c.json({error:'adaptation_invalid_control'},400);return c.json(await adaptationStore().control(body.enabled));});
app.post('/api/adaptation',async c=>{const v=await c.req.json();return c.json(await adaptationTool(c.req.header('idempotency-key')??'',v.action,v.input,'public'));});
app.post('/api/site/briefs',async c=>c.json(await siteFeatureStore().register(await c.req.json())));
app.post('/api/site/briefs/:id/disable',async c=>c.json(await siteFeatureStore().disable(c.req.param('id'))));
app.post('/api/site/control',async c=>{const body=await c.req.json();if(!body||typeof body.enabled!=='boolean'||Object.keys(body).length!==1)return c.json({error:'site_invalid_control'},400);return c.json(await siteStore().control(body.enabled));});
app.get('/api/site',async c=>c.json({...await siteStore().current(),history:await siteStore().history()}));
app.post('/api/site',async c=>{const v=await c.req.json();return c.json(await siteTool(c.req.header('idempotency-key')??'',v.action??'update_site',v.input,'operator'));});
app.get('/api/builder/health',async c=>c.json(await builderSandboxHealth(c.req.header('x-vercel-oidc-token'))));
app.get('/api/builder/projects',async c=>c.json(await readBuilder()));
app.get('/api/builder/projects/:id',async c=>c.json(await readBuilder({id:c.req.param('id'),path:c.req.query('path'),offset:c.req.query('offset')===undefined?undefined:Number(c.req.query('offset'))})));
app.post('/api/builder/projects',async c=>{const v=await c.req.json(),key=c.req.header('idempotency-key');if(!key||!/^[a-zA-Z0-9:_-]{1,120}$/.test(key))return c.json({error:'request_id_required'},400);const runtime=buildRuntime(v.runtime);if(!builderRuntimeEnabled(await store.configuration(),runtime))return c.json({error:'builder_runtime_disabled'},409);const p=await builderStore().create(key,v.title,v.goal,'claus','prototype',undefined,runtime);return c.json(await startBuilder(p.id),202);});
app.post('/api/builder/tick',async c=>c.json(await builderTick((await c.req.json()).id)));
app.get('/api/builder/recover',async c=>c.json(await recoverBuilder()));
app.post('/api/lab/setup',async c=>{await labStore().initialize();return c.json({initialized:true,activated:false});});
app.get('/api/lab/status',async c=>{const {settings}=await currentLab();return c.json({settings,extensions:researchExtensions(settings),clubBridge:(await store.sql()`SELECT result,updated_at FROM claus_club_bridge WHERE id`)[0]??null,...await labStore().envelope(),ideas:await labStore().ideas()});});
app.post('/api/lab/tick',async c=>c.json(await tickResearch()));
app.post('/api/lab/start',async c=>c.json(await startResearch()));
app.get('/api/lab/recover',async c=>c.json(await startResearch(true)));
app.post('/api/lab/ideas/:id/decision',async c=>{const input=await c.req.json(),publication=await labPublicContext();if(input.decision==='approved')requireCurrentLabState(publication);return c.json(await labStore().decide(c.req.param('id'),input.expectedRevision,input.proposalRevision,input.decision,publication.factsHash));});
app.post('/api/backup/checkpoint',async c=>{
  const {projectId,snapshotId}=await c.req.json();
  const data=await exportBackupCheckpoint(projectId,snapshotId);
  c.header('Cache-Control','no-store');c.header('Content-Type','application/octet-stream');
  return stream(c,async out=>{for(let i=0;i<data.length;i+=65536)await out.write(data.subarray(i,i+65536));});
});
app.post('/api/setup',async c=>{
  await store.initialize();
  try {
    const current=await store.configuration();
    return c.json({revision:current.revision,hash:current.hash,existing:true});
  } catch(error) {
    if(!(error instanceof Error)||error.message!=='configuration_not_seeded')throw error;
  }
  try {return c.json(await store.configure(await c.req.json()));}
  catch(error) {
    if(!(error instanceof Error)||error.message!=='configuration_conflict')throw error;
    const current=await store.configuration();
    return c.json({revision:current.revision,hash:current.hash,existing:true});
  }
});
app.get('/api/status',async c=>c.json({state:await store.state(),configuration:await store.configuration(),journal:await store.recent(),drafts:await store.drafts(),unresolved:await store.unresolved(),archive:await archiveOverview()}));
app.get('/api/inference-bindings',c=>c.json(inferenceBindings()));
app.get('/api/missions',async c=>c.json(await activeMissions()));
app.post('/api/network-surface/setup',async c=>{const v=await c.req.json();const host=new SurfaceHost();await host.assertProject(v.projectId);const d=await host.reconcile(v.projectId,'sr_bootstrap_20261014_v2',sourceHash(initialSource),v.deploymentId);if(!d||d.state!=='READY')return c.json({error:'surface_bootstrap_not_ready'},409);await host.verifySource(d.id,initialSource,'sr_bootstrap_20261014_v2',sourceHash(initialSource));const proof=await host.verify(d.url,'sr_bootstrap_20261014_v2',sourceHash(initialSource));return c.json(await surfaceStore().bootstrap(v.projectId,d,proof));});
app.get('/api/network-surface',async c=>c.json(await surfaceStore().read(c.req.query('path'),Number(c.req.query('offset')??0),c.req.query('id'))));
app.post('/api/network-surface/control',c=>c.json({error:'fixed_operator_control_required'},410));
app.get('/api/network-surface/host',async c=>{try{const current=await surfaceStore().current();await new SurfaceHost().assertProject(current.project_id);return c.json({ready:true});}catch(error){const code=error instanceof Error&&/^surface_[a-z0-9_]+$/.test(error.message)?error.message:'surface_host_unavailable';return c.json({ready:false,error:code},503);}});
app.get('/api/network-surface/runner',async c=>c.json({active:await builderStore().coordination.active(),deploymentId:process.env.VERCEL_DEPLOYMENT_ID}));
app.post('/api/network-surface/runner',c=>c.json({error:'fixed_operator_control_required'},410));
app.post('/api/network-surface/check',async c=>c.json(await monitorSurface()));
app.post('/api/network-surface/recover-review',async c=>{const v=await c.req.json();if(!v||Object.keys(v).some(k=>!['id','expectedReviewEffect'].includes(k)))return c.json({error:'surface_recovery_invalid'},400);return c.json(await surfaceStore().recoverReview(v.id,v.expectedReviewEffect,labInference()));});
app.post('/api/network-surface/retry-review',async c=>{const v=await c.req.json();if(!v||Object.keys(v).some(k=>!['id','expectedReviewEffect'].includes(k)))return c.json({error:'surface_retry_invalid'},400);return c.json(await surfaceStore().retryReview(c.req.header('idempotency-key')??'',v.id,v.expectedReviewEffect));});
app.get('/api/network-operations',async c=>c.json({enabled:networkOperationsEnabled(await store.configuration()),...await networkOperations.read()}));
// Operator recovery uses the same participant policy. Status can still reconcile
// a previously signed receipt after new work-wallet spending is disabled.
app.get('/api/work-wallet',async c=>{c.header('Cache-Control','no-store');return c.json(await workWallet.tool({operation:'status',input:JSON.stringify(c.req.query('id')?{id:c.req.query('id')}:{})}));});
app.post('/api/work-wallet',async c=>{c.header('Cache-Control','no-store');return c.json(await executeTool('operator-work-wallet','work_wallet',await c.req.json()));});
app.post('/api/missions',c=>c.json({error:'fixed_owner_mission_required'},410));
// Operator-only selection for a separately authorized next test/production
// deployment. Ordinary agent publications retain the current token and hook.
app.post('/api/public-project',async c=>{
  const v=await c.req.json();
  if(!/^[A-Za-z0-9_:.-]{1,160}$/.test(v?.id??'')||typeof v?.expectedTokenAddress!=='string')return c.json({error:'invalid_public_project_selection'},400);
  return c.json(await publishUpdate(v.id,v.update,{replaceProject:true,expectedTokenAddress:v.expectedTokenAddress}));
});
app.get('/api/wallet-policy',async c=>{
  const config=await store.configuration();
  const blockingRules=config.policy.rules.filter(r=>r.enabled&&['no-production-launch','no-unsolicited-transfers'].includes(r.id)).map(r=>r.id);
  if(config.policy.rules.some(r=>r.enabled&&r.id==='authorized-neutral-experiment')&&!hasWriteMission(await activeMissions()))blockingRules.push('no-active-write-mission');
  return c.json({revision:config.revision,enabled:config.settings.enabled,mode:config.settings.mode,chainWrite:config.policy.capabilities.chainWrite,externalTransfer:config.policy.capabilities.externalTransfer,blockingRules});
});
app.get('/api/overview',async c=>{
  const [configuration,state,actions,archive,replyDelivery,attention,published,[lastDecision]]=await Promise.all([store.configuration(),store.state(),store.unresolved(),archiveOverview(),replyDeliveryOverview(),operatorAttention(),publicState(),store.sql()`SELECT visibility AS channel,created_at AS at,data->>'configRevision' AS revision,data->>'publicationFactsHash' AS "factsHash" FROM claus_journal WHERE kind='inference' ORDER BY id DESC LIMIT 1`]);
  const factsHash=publicationFactsHash(published);
  const knowledge={publicationRevision:'revision' in published?published.revision:null,factsHash,configurationRevision:configuration.revision,lastDecision:lastDecision??null,currentAtLastDecision:lastDecision?.factsHash===factsHash&&Number(lastDecision?.revision)===configuration.revision,audit:knowledgeAudit(configuration,published)};
  return c.json({...operationalOverview(configuration,state,actions,archive.projects,referenceOverview()),replyDelivery,attention,knowledge});
});
app.get('/api/x/attention',async c=>{c.header('Cache-Control','no-store');return c.json(await operatorAttention(c.req.query('before')));});
app.post('/api/x/attention/:id/review',async c=>{const input=await c.req.json();return c.json(await reviewSecurityReport(c.req.param('id'),input.issue));});
app.get('/api/reference',async c=>c.json(readReference({path:c.req.query('path'),query:c.req.query('query'),offset:c.req.query('offset')===undefined?undefined:Number(c.req.query('offset')),limit:c.req.query('limit')===undefined?undefined:Number(c.req.query('limit'))},await store.configuration())));
app.get('/api/knowledge',async c=>c.json(await readKnowledgeResolved({id:c.req.query('id'),query:c.req.query('query'),kind:c.req.query('kind'),version:c.req.query('version'),offset:c.req.query('offset')===undefined?undefined:Number(c.req.query('offset')),limit:c.req.query('limit')===undefined?undefined:Number(c.req.query('limit'))},await store.configuration(),await publicState())));
// Operator diagnostics use the same bounded read paths, never a generic tool runner.
app.post('/api/observations/:tool',async c=>{
  const name=c.req.param('tool');
  if(!['read_chain','read_contract_source','read_market','search_web'].includes(name))return c.json({error:'read_tool_required'},400);
  c.header('Cache-Control','no-store');
  return c.json(await executeTool('operator-observation',name,await c.req.json()));
});
app.post('/api/visuals/:tool',async c=>{
  const name=c.req.param('tool'),id=c.req.header('idempotency-key');
  if(!['read_image','generate_image','prepare_gif'].includes(name)||!id||!/^[a-zA-Z0-9:_-]{1,140}$/.test(id))return c.json({error:'visual_tool_and_stable_id_required'},400);
  return c.json(await executeTool(id,name,await c.req.json()));
});
app.get('/api/archive',async c=>c.json(await recall({query:c.req.query('query'),id:c.req.query('id'),includeSuperseded:c.req.query('includeSuperseded')==='true',offset:c.req.query('offset')===undefined?undefined:Number(c.req.query('offset')),limit:c.req.query('limit')===undefined?undefined:Number(c.req.query('limit'))})));
app.put('/api/config',async c=>c.json({error:'configuration_managed_externally'},410));
app.get('/api/config/:revision',async c=>c.json(await store.historicalConfiguration(Number(c.req.param('revision')))));
app.post('/api/uniswap/prepare',async c=>c.json(await uniswapRequest(await c.req.json())));
app.get('/api/x/verify',async c=>c.json(await verifyX()));
app.post('/api/release/prepare',async c=>{
  const id=c.req.header('idempotency-key');
  if(!id||!/^[A-Za-z0-9_:.-]{1,160}$/.test(id))return c.json({error:'release_id_required'},400);
  return c.json(await prepareRelease(id,await c.req.json()));
});
app.post('/api/upgrade',async c=>{
  const input=await c.req.json();
  if(input?.drain===true){
    if(input.kind!=='social'||input.resumePaused!==undefined)return c.json({error:'invalid_drain_upgrade'},400);
    if(!modelReady())return c.json({error:'inference_unavailable'},409);
    try{return c.json(await ownerRuntimeHandoff(productionLabDatabase(),new OperationsHost(),async generation=>(await start(life,[generation])).runId,input));}
    catch(e){const error=e instanceof Error&&e.message.startsWith('runtime_handoff_')?e.message:'runtime_handoff_unavailable';return c.json({error},409);}
  }
  if(!input||!['social','research'].includes(input.kind)||!Number.isSafeInteger(input.expectedGeneration)||input.expectedGeneration<1||input.resumePaused!==undefined&&typeof input.resumePaused!=='boolean')return c.json({error:'invalid_upgrade'},400);
  if(!modelReady())return c.json({error:'inference_unavailable'},409);
  const preserveClock=input.resumePaused||input.kind==='research';
  const resumed=preserveClock?await resumeGeneration(productionLabDatabase(),input.kind,input.expectedGeneration):undefined;
  const generation=preserveClock?resumed?.generation??null:await upgradeGeneration(productionLabDatabase(),input.kind,input.expectedGeneration);
  if(generation===null)return c.json({state:'busy_disabled_or_superseded'},409);
  const run=input.kind==='social'?await start(life,[generation]):await start(researchLife,resumed?.notBefore?[generation,resumed.notBefore]:[generation]);
  await store.journal('runtime_upgrade','Changed runtime code between turns',{kind:input.kind,generation,runId:run.runId});
  return c.json({state:'started',kind:input.kind,generation,runId:run.runId});
});
app.get('/api/upgrade',async c=>{try{const result=await readRuntimeHandoff(productionLabDatabase(),c.req.query('id')??'');return result?c.json(result):c.json({error:'not_found'},404);}catch{return c.json({error:'runtime_handoff_unavailable'},503);}});
app.post('/api/start',async c=>{
  const config=await store.configuration();
  if(!config.settings.enabled||!modelReady()) return c.json({error:'enable_and_connect_inference_first'},409);
  const state=await store.state();
  const generation=await store.beginGeneration(state.generation);
  if(generation===undefined)return c.json({error:'already_active_or_requires_reconciliation'},409);
  const run=await start(life,[generation]);
  await store.journal('started','Agent test operation started',{generation,runId:run.runId});
  return c.json({runId:run.runId,generation});
});
app.get('/api/recover',async c=>{
  if(!process.env.DATABASE_URL)return c.json({status:'waiting_for_database_setup'});
  const config=await store.configuration();
  if(!config.settings.enabled||!modelReady()) return c.json({status:'paused'});
  const host=await import('./runtime-host.js').then(m=>m.resumePrimaryHost());
  if(host.status==='resume'){
   const run=await start(life,[host.generation]);
   await store.journal('recovery','Resumed the original state after standby execution',{generation:host.generation,runId:run.runId});
   return c.json({status:'resumed',runId:run.runId});
  }
  if(host.status!=='primary')return c.json({status:host.status});
  if(process.env.PUBLISHER_SECRET){
   try{const {operationalHandoff}=await import('./operations/handoff.js');const {OperationsHost}=await import('./operations/host.js');const handoff=await operationalHandoff(productionLabDatabase(),new OperationsHost(),async generation=>(await start(life,[generation])).runId);if(handoff)return c.json({status:'operational_handoff',...handoff});}catch{/* Existing recovery still handles overdue work. */}
  }
  const state=await store.state();
  if(state.status==='paused') return c.json({status:'paused'});
  if(state.status==='blocked') return c.json({status:'requires_reconciliation'});
  await import('./runtime-host.js').then(m=>m.runtimeHostPulse(state.generation));
  const mentions=config.policy.capabilities.xRead&&config.policy.capabilities.xReply;
  const poll=mentions?(await store.sql()`SELECT next_poll_at,lease_until FROM claus_x_poll WHERE id=1`)[0]??null:null;
  if(!recoveryCandidate({status:state.status,next_at:state.next_at,updated_at:state.updated_at,lease_until:state.lease_until},poll?{next_poll_at:poll.next_poll_at,lease_until:poll.lease_until}:null,mentions))return c.json({status:'healthy_or_waiting'});
  // Recheck deadlines, generation and leases atomically; preserve next_at,
  // memory, continuation, cursors and all existing action reservations.
  const generation=await store.recoverGeneration(state.generation,mentions);
  if(generation===undefined)return c.json({status:'already_recovered_or_not_due'});
  const run=await start(life,[generation]);
  await store.journal('recovery','Resumed overdue work or mention polling',{generation,runId:run.runId});
  return c.json({status:'resumed',runId:run.runId});
});
app.onError((error,c)=>{
  // Provider errors must never serialize request headers or connection strings.
  const safe=/^(database_not_connected|configuration_not_seeded|x_[a-z_0-9]+)$/.test(error.message)?error.message:'operation_failed';
  return c.json({error:safe},503);
});
export default app;
