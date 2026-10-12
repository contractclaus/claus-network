import { timingSafeEqual } from 'node:crypto';
import { createReviewWorker } from '../runtime/review-worker.mjs';

let loaded;
export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const secret = process.env.CRON_SECRET, auth = req.headers.authorization;
  if (req.method !== 'GET' || typeof secret !== 'string' || secret.length < 32 || typeof auth !== 'string' ||
      auth.length !== secret.length + 7 || !timingSafeEqual(Buffer.from(auth), Buffer.from('Bearer ' + secret))) {
    res.status(401).json({ error: 'unauthenticated' }); return;
  }
  try {
    loaded ??= createReviewWorker().catch(error => { loaded = null; throw error; });
    const worker = await loaded;
    res.status(200).json({ ok: true, ...await worker.tick() });
  } catch { res.status(503).json({ error: 'worker_unavailable' }); }
}
