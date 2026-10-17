import {openRuntime} from '../runtime/bootstrap.mjs';
import {runtimeHealth} from '../runtime/health.mjs';
import {SITE_LIMITS} from '../src/shared/index.mjs';
import {requestUrl} from '../runtime/request-url.mjs';
let loaded;
export function application(){
  return loaded??=(openRuntime().catch(error=>{loaded=null;throw error;}));
}
export default async function handler(req, res) {
  try {
    const { app, store, intakePorts, databaseBoundary } = await application();
    const url = requestUrl(req.url, process.env.CLAUS_NETWORK_ORIGIN);
    let response;
    if (url.pathname === '/health') {
      response = await runtimeHealth({app,store,intakePorts,databaseBoundary});
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
