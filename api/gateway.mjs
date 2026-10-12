import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { openPostgresStore } from '../src/postgres/index.mjs';
import { createApplication } from '../runtime/server.mjs';
import { requestUrl } from '../runtime/request-url.mjs';

neonConfig.webSocketConstructor = ws;
let loaded;
function application() {
  if (!loaded) loaded = (async () => {
    if (!process.env.CLAUS_NETWORK_DATABASE_URL || !process.env.CLAUS_NETWORK_ORIGIN) throw Error('runtime_unconfigured');
    const pool = new Pool({ connectionString: process.env.CLAUS_NETWORK_DATABASE_URL, max: 3, connectionTimeoutMillis: 8000 });
    const store = await openPostgresStore({ pool });
    return { store, app: createApplication({ store, origin: process.env.CLAUS_NETWORK_ORIGIN, rateSalt: process.env.CLAUS_NETWORK_RATE_SALT }) };
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
      response = Response.json({ service: 'Claus Network', status: 'ok',
        release: process.env.CLAUS_NETWORK_RELEASE ?? null,
        capabilities: ['identity', 'project.registry', 'source.snapshot', 'build.compile', 'public.projection'],
        reviewExecution: 'not_enabled', mainnetExecution: 'not_enabled' });
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
