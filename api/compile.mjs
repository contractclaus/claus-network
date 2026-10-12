import { timingSafeEqual } from 'node:crypto';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { openPostgresStore } from '../src/postgres/index.mjs';
import { createApplication } from '../runtime/server.mjs';
import { compileSnapshot } from '../adapters/compiler.mjs';

neonConfig.webSocketConstructor = ws;
let loaded;
export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const secret = process.env.CRON_SECRET;
  const supplied = req.headers.authorization;
  if (req.method !== 'GET' || !secret || typeof supplied !== 'string' ||
    supplied.length !== secret.length + 7 || !timingSafeEqual(Buffer.from(supplied), Buffer.from('Bearer ' + secret))) {
    res.status(401).json({ error: 'unauthenticated' }); return;
  }
  try {
    loaded ??= (async () => {
      const store = await openPostgresStore({ pool: new Pool({ connectionString: process.env.CLAUS_NETWORK_DATABASE_URL,
        max: 2, connectionTimeoutMillis: 8000 }) });
      const app = createApplication({ store, origin: process.env.CLAUS_NETWORK_ORIGIN, rateSalt: process.env.CLAUS_NETWORK_RATE_SALT });
      return { store, app };
    })().catch(error => { loaded = null; throw error; });
    const { store, app } = await loaded;
    const result = await app.builds.runOne(compileSnapshot);
    await store.transaction(async tx => {
      const old = await tx.read('worker-health', 'compile');
      await tx.write('worker-health', 'compile', { observedAt: Date.now(), release: process.env.CLAUS_NETWORK_RELEASE,
        idle: result.idle === true, state: result.state ?? null }, old?.revision ?? 0);
    });
    res.status(200).json({ ok: true, idle: result.idle === true, state: result.state ?? null });
  } catch { res.status(503).json({ error: 'worker_unavailable' }); }
}
