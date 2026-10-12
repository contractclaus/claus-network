import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { openPostgresStore } from '../src/postgres/index.mjs';
import { createApplication } from '../runtime/server.mjs';
import { requestUrl } from '../runtime/request-url.mjs';
import { operatorConfig } from '../runtime/operator-config.mjs';

neonConfig.webSocketConstructor = ws;
let loaded;
function application() {
  if (!loaded) loaded = (async () => {
    if (!process.env.CLAUS_NETWORK_DATABASE_URL || !process.env.CLAUS_NETWORK_ORIGIN) throw Error('runtime_unconfigured');
    const pool = new Pool({ connectionString: process.env.CLAUS_NETWORK_DATABASE_URL, max: 3, connectionTimeoutMillis: 8000 });
    const store = await openPostgresStore({ pool });
    return { store, app: createApplication({ store, origin: process.env.CLAUS_NETWORK_ORIGIN,
      rateSalt: process.env.CLAUS_NETWORK_RATE_SALT, operatorPorts: operatorConfig() }) };
  })().catch(error => { loaded = null; throw error; });
  return loaded;
}
export default async function handler(req, res) {
  try {
    const { app, store } = await application();
    const url = requestUrl(req.url, process.env.CLAUS_NETWORK_ORIGIN);
    let response;
    if (url.pathname === '/health') {
      await store.read('network', 'authority');
      const review = (await store.read('network-capabilities', 'review'))?.value;
      const worker = (await store.read('worker-health', 'review'))?.value;
      const enabled = review?.enabled === true;
      const recent = worker?.observedAt > Date.now() - 300000;
      const chain = (await store.read('network-capabilities', 'chain'))?.value;
      const controller = (await store.read('worker-health', 'controller'))?.value;
      const executor = (await store.read('worker-health', 'executor'))?.value;
      const collaboration = (await store.read('network-capabilities', 'collaboration'))?.value;
      const wallets = (await store.read('network-capabilities', 'wallets'))?.value;
      const serviceWorker = (await store.read('worker-health', 'services'))?.value;
      const walletWorker = (await store.read('worker-health', 'wallets'))?.value;
      const vaults = (await store.read('network-capabilities', 'vaults'))?.value;
      const vaultWorker = (await store.read('worker-health', 'vaults'))?.value;
      const portability = (await store.read('network-capabilities', 'portability'))?.value;
      response = Response.json({ service: 'Claus Network', status: 'ok',
        release: process.env.CLAUS_NETWORK_RELEASE ?? null,
        capabilities: ['identity', 'project.registry', 'source.snapshot', 'build.compile', 'public.projection'],
        reviewExecution: enabled ? recent ? 'restricted_pilot' : 'worker_unavailable' : 'not_enabled',
        testnetExecution: chain?.enabled === true ? controller?.observedAt > Date.now() - 300000 && executor?.observedAt > Date.now() - 300000 ? 'restricted_pilot' : 'worker_unavailable' : 'not_enabled',
        collaborationExecution: collaboration?.enabled === true ? serviceWorker?.observedAt > Date.now() - 300000 ? 'restricted_pilot' : 'worker_unavailable' : 'not_enabled',
        walletExecution: wallets?.enabled === true ? walletWorker?.observedAt > Date.now() - 300000 ? 'restricted_pilot' : 'worker_unavailable' : 'not_enabled',
        vaultExecution: vaults?.enabled === true ? vaultWorker?.observedAt > Date.now() - 300000 ? 'restricted_pilot' : 'worker_unavailable' : 'not_enabled',
        portabilityExecution: portability?.enabled === true ? 'restricted_pilot' : 'not_enabled',
        inferenceExecution: 'not_enabled',
        contractIntakeExecution: 'not_enabled',
        mainnetExecution: 'not_enabled' });
    } else {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
      let body;
      if (!['GET', 'HEAD'].includes(req.method)) {
        if (req.body !== undefined) body = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body);
        else {
          const chunks = []; let bytes = 0;
          for await (const chunk of req) { bytes += chunk.length; if (bytes > 300000) { res.status(413).json({ error: 'request_too_large' }); return; } chunks.push(chunk); }
          body = Buffer.concat(chunks);
        }
        if (Buffer.byteLength(body) > 300000) { res.status(413).json({ error: 'request_too_large' }); return; }
      }
      const request = new Request(url, { method: req.method, headers, ...(body === undefined ? {} : { body }) });
      response = await app.fetch(request, { peer: req.headers['x-vercel-forwarded-for'] ?? req.socket?.remoteAddress ?? 'platform' });
    }
    res.statusCode = response.status;
    for (const [key, value] of response.headers) res.setHeader(key, value);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'no-store');
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.statusCode = 503; res.setHeader('content-type', 'application/json'); res.end('{"error":"service_unavailable"}'); }
}
