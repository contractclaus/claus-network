import {imageArchive} from '../runtime/image-objects.mjs';
import {infrastructurePorts} from '../runtime/infrastructure-ports.mjs';
import {ociPorts} from '../runtime/oci-ports.mjs';
import {sourceObjects} from '../runtime/source-objects.mjs';
import {isolatedHealth} from '../src/isolated/bridge.mjs';
import {readDatabaseBoundary} from '../runtime/database-boundary.mjs';
import {inferencePorts} from '../runtime/inference-ports.mjs';
import {SITE_LIMITS} from '../src/shared/index.mjs';
import {openAppPostgres} from '../src/app-storage/index.mjs';
import {dealPorts} from '../runtime/deal-ports.mjs';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { openPostgresStore } from '../src/postgres/index.mjs';
import { readonlyPorts } from '../runtime/readonly-ports.mjs';
import { createApplication } from '../runtime/server.mjs';
import { requestUrl } from '../runtime/request-url.mjs';
import { operatorConfig } from '../runtime/operator-config.mjs';
import { contractIntakePorts, contractIntakeHealth } from '../runtime/contract-intake-config.mjs';

neonConfig.webSocketConstructor = ws;
let loaded;
export function application() {
  if (!loaded) loaded = (async () => {
    if (!process.env.CLAUS_NETWORK_DATABASE_URL || !process.env.CLAUS_NETWORK_ORIGIN) throw Error('runtime_unconfigured');
    const pool = new Pool({ connectionString: process.env.CLAUS_NETWORK_DATABASE_URL, max: 3, connectionTimeoutMillis: 8000 });
    pool.on('error', () => {});
    try { await readDatabaseBoundary(pool); }
    catch (error) { await pool.end().catch(() => {}); throw error; }
    const store = await openPostgresStore({ pool });
    const intakePorts = contractIntakePorts();
    const oci=ociPorts();
    const infrastructure=infrastructurePorts();
    return { store, intakePorts, databaseBoundary: () => readDatabaseBoundary(pool), app: createApplication({ imageArchive:await imageArchive(),infrastructurePorts:infrastructure.ports,infrastructureEnabled:infrastructure.enabled,ociBuildPorts:oci.ports,ociBuildEnabled:oci.enabled,sourceObjects:await sourceObjects(),inferencePorts:inferencePorts(),arbitrationEnabled:process.env.CLAUS_DEAL_ARBITRATION_ENABLED==='1',workersEnabled:process.env.CLAUS_WORKERS_ENABLED==='1',domainsEnabled:process.env.CLAUS_DOMAINS_ENABLED==='1',dealPorts:dealPorts(),appWritesEnabled:process.env.CLAUS_APPS_WRITES_ENABLED!=='0', appStorage:process.env.CLAUS_APPS_ENABLED==='1'?await openAppPostgres({pool}):null, store, origin: process.env.CLAUS_NETWORK_ORIGIN,
      rateSalt: process.env.CLAUS_NETWORK_RATE_SALT, operatorPorts: operatorConfig(), chainPorts: readonlyPorts(), intakePorts }) };
  })().catch(error => { loaded = null; throw error; });
  return loaded;
}
export default async function handler(req, res) {
  try {
    const { app, store, intakePorts, databaseBoundary } = await application();
    const url = requestUrl(req.url, process.env.CLAUS_NETWORK_ORIGIN);
    let response;
    if (url.pathname === '/health') {
      const boundary = await databaseBoundary();
      const names=['review','chain','collaboration','wallets','vaults','portability'];
      const roles=['review','controller','executor','services','wallets','vaults'];
      const [,caps,health]=await Promise.all([store.read('network','authority'),store.readMany('network-capabilities',names),store.readMany('worker-health',roles)]);
      const review=caps.get('review')?.value,worker=health.get('review')?.value;
      const enabled=review?.enabled===true,recent=worker?.observedAt>Date.now()-300000;
      const chain=caps.get('chain')?.value,controller=health.get('controller')?.value,executor=health.get('executor')?.value;
      const collaboration=caps.get('collaboration')?.value,wallets=caps.get('wallets')?.value,serviceWorker=health.get('services')?.value,walletWorker=health.get('wallets')?.value;
      const vaults=caps.get('vaults')?.value,vaultWorker=health.get('vaults')?.value,portability=caps.get('portability')?.value;
      const publicAccess = await app.access.discovery();
      const intakeState = await contractIntakeHealth(store, intakePorts);
      response = Response.json({ service: 'Claus Network', status: 'ok', databaseBoundary:boundary, isolatedAnalysis:await isolatedHealth(),
        release: process.env.CLAUS_NETWORK_RELEASE ?? null,
        sourceStorage:{profile:app.sourceFiles.enabled?'private-r2-with-inline-small-files':'database', inlineMaxBytes:4096},
        capabilities: ['identity', 'project.registry', 'source.snapshot', 'build.compile', 'public.projection'],
        projectAccess: publicAccess.projectAccess,
        admission: publicAccess,
        reviewExecution: enabled ? recent ? publicAccess.reviews.admission : 'worker_unavailable' : 'not_enabled',
        testnetExecution: chain?.enabled === true ? controller?.observedAt > Date.now() - 300000 && executor?.observedAt > Date.now() - 300000 ? publicAccess.chainProfiles[0].admission : 'worker_unavailable' : 'not_enabled',
        collaborationExecution: collaboration?.enabled === true ? serviceWorker?.observedAt > Date.now() - 300000 ? publicAccess.collaboration.admission : 'worker_unavailable' : 'not_enabled',
        walletExecution: wallets?.enabled === true ? walletWorker?.observedAt > Date.now() - 300000 ? 'restricted_pilot' : 'worker_unavailable' : 'not_enabled',
        vaultExecution: vaults?.enabled === true ? vaultWorker?.observedAt > Date.now() - 300000 ? 'restricted_pilot' : 'worker_unavailable' : 'not_enabled',
        portabilityExecution: portability?.enabled === true ? publicAccess.collaboration.admission : 'not_enabled',
        applications: { enabled: app.apps.enabled, profile: 'managed-records-and-tasks-v1', limits: app.apps.limits },
        inferenceExecution: publicAccess.publicInference,
        contractIntakeExecution: intakeState,
        mainnetContractIntakeExecution: await contractIntakeHealth(store, intakePorts, Date.now(), 1),
        mainnetExecution: publicAccess.mainnet === 'public_readonly' ?
          controller?.chains?.includes(1) && executor?.chains?.includes(1) &&
          controller.observedAt > Date.now() - 300000 && executor.observedAt > Date.now() - 300000 ? 'public_readonly' : 'worker_unavailable' : 'not_enabled' });
    } else {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
      let body;const maximum=/^\/v1\/(?:projects\/[^/]+\/snapshots|admin\/content\/[^/]+\/corrections)$/.test(url.pathname)||url.pathname==='/mcp'?SITE_LIMITS.requestBytes:300000;
      if (!['GET', 'HEAD'].includes(req.method)) {
        if (req.body !== undefined) body = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body);
        else {
          const chunks = []; let bytes = 0;
          for await (const chunk of req) { bytes += chunk.length; if (bytes > maximum) { res.status(413).json({ error: 'request_too_large' }); return; } chunks.push(chunk); }
          body = Buffer.concat(chunks);
        }
        if (Buffer.byteLength(body) > maximum) { res.status(413).json({ error: 'request_too_large' }); return; }
      }
      const abort = new AbortController();res.once('close',()=>abort.abort());
      const request = new Request(url, { method: req.method, signal:abort.signal, headers, ...(body === undefined ? {} : { body }) });
      response = await app.fetch(request, { peer: req.headers['x-vercel-forwarded-for'] ?? req.socket?.remoteAddress ?? 'platform' });
    }
    res.statusCode = response.status;
    for (const [key, value] of response.headers) res.setHeader(key, value);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'no-store');
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.statusCode = 503; res.setHeader('content-type', 'application/json'); res.end('{"error":"service_unavailable"}'); }
}
