import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { privateKeyToAccount } from 'viem/accounts';
import { openPostgresStore } from '../src/postgres/index.mjs';
import { createApplication } from './server.mjs';
import { createContractDelivery } from '../adapters/contract-delivery.mjs';
import { createContractIntakeWorker } from './contract-intake-worker.mjs';
import { createSealer } from '../adapters/secrets.mjs';
import { digest, requireThat } from '../src/shared/index.mjs';
import { contractIntakePorts } from './contract-intake-config.mjs';

// Separate signing host. One explicitly admitted lifetime budget is selected;
// no API request or worker restart creates, replenishes or changes it.
export async function createHostedContractIntakeWorker(env = process.env) {
  const ports = contractIntakePorts(env);
  requireThat(ports.pin && env.CLAUS_CONTRACT_DISPATCH_BUDGET, 'intake_host_unconfigured');
  neonConfig.webSocketConstructor = ws;
  const store = await openPostgresStore({ pool: new Pool({ connectionString: env.CLAUS_NETWORK_DATABASE_URL,
    max: 3, connectionTimeoutMillis: 8000 }) });
  try {
    const signer = privateKeyToAccount(env.CLAUS_CONTRACT_DISPATCH_KEY);
    requireThat(signer.address.toLowerCase() === ports.pin.dispatcher.toLowerCase(), 'dispatch_signer_mismatch');
    const budget = (await store.read('contract-dispatch-budgets', env.CLAUS_CONTRACT_DISPATCH_BUDGET))?.value.config;
    requireThat(budget && budget.inbox === ports.pin.inbox.toLowerCase() &&
      budget.codeHash === ports.pin.codeHash && budget.chainId === ports.pin.chainId, 'dispatch_budget_mismatch');
    const app = createApplication({ store, origin: env.CLAUS_NETWORK_ORIGIN,
      rateSalt: env.CLAUS_NETWORK_RATE_SALT, intakePorts: ports });
    const delivery = createContractDelivery({ store, client: ports.client, signer,
      sealer: createSealer(env.CLAUS_NETWORK_SEALING_KEY), chain: ports.chain, identity: app.identity, budget,
      admitted: ports.verifyAdmission });
    const worker = createContractIntakeWorker({ store, intake: app.intake, chain: ports.chain, delivery,
      startBlock: ports.pin.startBlock, enabled: () => ports.verifyAdmission(store) });
    return { store, async tick() {
      const result = await worker.tick();
      await store.transaction(async tx => {
        const old = await tx.read('worker-health', 'contract-intake');
        await tx.write('worker-health', 'contract-intake', { ...result, observedAt: Date.now(),
          release: env.CLAUS_NETWORK_RELEASE, profileHash: digest(ports.pin) }, old?.revision ?? 0);
      });
      return result;
    } };
  } catch (error) { await store.close(); throw error; }
}
