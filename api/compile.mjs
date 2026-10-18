import {hostContinuity} from '../src/continuity-host.mjs';
import { timingSafeEqual } from 'node:crypto';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { openPostgresStore } from '../src/postgres/index.mjs';
import { createApplication } from '../runtime/server.mjs';
import { compileSnapshot } from '../adapters/compiler.mjs';
import { sourceObjects } from '../runtime/source-objects.mjs';

neonConfig.webSocketConstructor = ws;
let loaded;
export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const secret = process.env.CRON_SECRET;
  const supplied = req.headers.authorization;
  if (req.method !== 'GET' || !secret || typeof supplied !== 'string' ||
    Buffer.byteLength(supplied) !== Buffer.byteLength('Bearer ' + secret) || !timingSafeEqual(Buffer.from(supplied), Buffer.from('Bearer ' + secret))) {
    res.status(401).json({ error: 'unauthenticated' }); return;
  }
  try {
    loaded ??= (async () => {
      const pool = new Pool({ connectionString: process.env.CLAUS_NETWORK_DATABASE_URL, max: 2, connectionTimeoutMillis: 8000 });
      pool.on('error', () => { loaded = null; void pool.end().catch(() => {}); });
      try {
        const store = await openPostgresStore({ pool });
        const app = createApplication({ sourceObjects: await sourceObjects(), store,
          origin: process.env.CLAUS_NETWORK_ORIGIN, rateSalt: process.env.CLAUS_NETWORK_RATE_SALT });
        return { store, app };
      } catch (error) { await pool.end().catch(() => {}); throw error; }
    })().catch(error => { loaded = null; throw error; });
    const outcome=await hostContinuity('worker:compile',null,{},async()=>{
    const { store, app } = await loaded;
    const maintenance = await store.pruneEphemeral();
    const result = await app.builds.runOne(compileSnapshot);
    await store.transaction(async tx => {
      const old = await tx.read('worker-health', 'compile');
      await tx.write('worker-health', 'compile', { observedAt: Date.now(), release: process.env.CLAUS_NETWORK_RELEASE,
        idle: result.idle === true, state: result.state ?? null, maintenance }, old?.revision ?? 0);
    });
    return { ok: true, idle: result.idle === true, state: result.state ?? null };});res.status(200).json(outcome);
  } catch { res.status(503).json({ error: 'worker_unavailable' }); }
}
