import { timingSafeEqual } from 'node:crypto';
import { createClient } from '../interfaces/sdk.mjs';
import { createReferenceWorker } from './providers.mjs';
export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const expected = Buffer.from('Bearer ' + (process.env.CRON_SECRET ?? ''));
  const actual = Buffer.from(req.headers.authorization ?? '');
  if (!process.env.CRON_SECRET || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    res.status(401).json({ error: 'unauthorized' }); return;
  }
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  try {
    const worker = createReferenceWorker({ role: process.env.CLAUS_REFERENCE_ROLE,
      client: createClient({ origin: 'https://claus-network-api.vercel.app', token: process.env.CLAUS_PROJECT_CREDENTIAL }),
      projectId: process.env.CLAUS_PROJECT_ID, serviceId: process.env.CLAUS_SERVICE_ID });
    res.status(200).json(await worker.tick());
  } catch { res.status(503).json({ error: 'reference_worker_unavailable' }); }
}
