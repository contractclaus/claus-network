import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { openPostgresStore } from '../src/postgres/index.mjs';
import { createApplication } from './server.mjs';
import { createSealer } from '../adapters/secrets.mjs';
import { createChainRead } from '../adapters/chain-read.mjs';
import { createClausController } from '../adapters/claus-controller.mjs';
import { createChainExecutor } from '../adapters/chain-executor.mjs';
import { createSourceVerification } from '../adapters/source-verification.mjs';
import { requireThat } from '../src/shared/index.mjs';

export async function createChainWorker(role, env = process.env) {
  requireThat(['controller', 'executor'].includes(role), 'invalid_worker_role');
  neonConfig.webSocketConstructor = ws;
  const store = await openPostgresStore({ pool: new Pool({ connectionString: env.CLAUS_NETWORK_DATABASE_URL, max: 3, connectionTimeoutMillis: 8000 }) });
  const client = createPublicClient({ transport: http('https://ethereum-sepolia-rpc.publicnode.com', { retryCount: 0, timeout: 15000 }) });
  const signer = privateKeyToAccount(env.CLAUS_CHAIN_PRIVATE_KEY);
  requireThat(signer.address.toLowerCase() === env.CLAUS_CHAIN_SIGNER?.toLowerCase(), 'worker_signer_mismatch');
  const chain = createChainRead({ client }), sealer = createSealer(env.CLAUS_NETWORK_SEALING_KEY);
  const app = createApplication({ store, origin: env.CLAUS_NETWORK_ORIGIN, rateSalt: env.CLAUS_NETWORK_RATE_SALT, chainPorts: { chain } });
  const controller = role === 'controller' ? createClausController({ store, chain, client, signer, secret: env.CLAUS_NETWORK_REVIEW_SECRET }) : null;
  const executor = role === 'executor' ? createChainExecutor({ store, chain, client, signer, sealer, artifacts: app.artifacts,
    verification: createSourceVerification({ store, etherscanKey: env.ETHERSCAN_API_KEY }) }) : null;
  return { store, async tick() {
    const capability = (await store.read('network-capabilities', 'chain'))?.value;
    if (capability?.enabled !== true) return { state: 'disabled' };
    const expected = role === 'controller' ? capability.approvalSigner : capability.executorPayer;
    requireThat(expected?.toLowerCase() === signer.address.toLowerCase(), 'worker_role_mismatch');
    await chain.capabilityMatches(capability);
    const work = role === 'controller' ? await app.approvals.runDecision(controller) : {
      deployment: await app.deployments.runOne(executor.deployment), execution: await app.approvals.runExecution(executor.execution) };
    const result = role === 'controller' ? { decision: work.state ?? 'idle' } : {
      deployment: work.deployment.state ?? 'idle', execution: work.execution.state ?? 'idle' };
    await store.transaction(async tx => {
      const old = await tx.read('worker-health', role);
      await tx.write('worker-health', role, { ...result, observedAt: Date.now(), release: env.CLAUS_NETWORK_RELEASE }, old?.revision ?? 0);
    });
    return result;
  } };
}
