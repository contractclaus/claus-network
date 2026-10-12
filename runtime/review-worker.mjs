import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { openPostgresStore } from '../src/postgres/index.mjs';
import { createApplication } from './server.mjs';
import { createSealer } from '../adapters/secrets.mjs';
import { createImdReviewProvider } from '../adapters/imd.mjs';
import { createImdPayment } from '../adapters/imd-payment.mjs';
import { createImdCostVerifier } from '../adapters/imd-cost.mjs';
import { verifyPublicSource } from '../adapters/public-source.mjs';
import { requireThat } from '../src/shared/index.mjs';

// Deployed separately from the public API and compiler. This process accepts
// no project source execution, arbitrary signing request or callback URL.
export async function createReviewWorker(env = process.env) {
  neonConfig.webSocketConstructor = ws;
  const signer = privateKeyToAccount(env.CLAUS_REVIEW_PRIVATE_KEY);
  requireThat(signer.address.toLowerCase() === env.CLAUS_REVIEW_PAYER?.toLowerCase(), 'review_signer_mismatch');
  const store = await openPostgresStore({ pool: new Pool({ connectionString: env.CLAUS_NETWORK_DATABASE_URL,
    max: 2, connectionTimeoutMillis: 8000 }) });
  const sealer = createSealer(env.CLAUS_NETWORK_SEALING_KEY);
  const client = createPublicClient({ transport: http(env.CLAUS_REVIEW_RPC_URL, { retryCount: 0, timeout: 15000 }) });
  let app;
  const provider = createImdReviewProvider({ store, sealer,
    resolveInput: (projectId, inputHash) => app.reviewSystem.flow.resolveInput(projectId, inputHash) });
  const cost = createImdCostVerifier({ client, payer: signer.address,
    readPayment: async id => (await store.read('imd-payments', id))?.value });
  app = createApplication({ store, origin: env.CLAUS_NETWORK_ORIGIN, rateSalt: env.CLAUS_NETWORK_RATE_SALT,
    reviewPorts: { provider, verifySource: verifyPublicSource, verifyCost: cost.verify } });
  const flow = app.reviewSystem.flow;
  const createPayment = claim => createImdPayment({ store, sealer, provider, signer,
    authorize: (input, reader) => flow.paymentAuthority(claim, input, reader) });
  return { store, async tick() {
    const quoted = await flow.runQuote();
    const reviewed = await flow.runPaid({ provider, createPayment, costReceipt: cost.receipt });
    const result = { quote: quoted.state ?? (quoted.idle ? 'idle' : 'stale'), review: reviewed.state ?? (reviewed.idle ? 'idle' : 'stale') };
    await store.transaction(async tx => {
      const old = await tx.read('worker-health', 'review');
      await tx.write('worker-health', 'review', { ...result, observedAt: Date.now(), release: env.CLAUS_NETWORK_RELEASE }, old?.revision ?? 0);
    });
    return result;
  } };
}
