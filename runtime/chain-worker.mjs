import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { openPostgresStore } from '../src/postgres/index.mjs';
import { createApplication } from './server.mjs';
import { createSealer } from '../adapters/secrets.mjs';
import { createChainRead } from '../adapters/chain-read.mjs';
import { createReadonlyChainRouter } from '../adapters/readonly-chain-router.mjs';
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
  const sepolia = createChainRead({ client }), sealer = createSealer(env.CLAUS_NETWORK_SEALING_KEY);
  const configuredMainnet = !!env.CLAUS_MAINNET_RPC_URL && !!env.CLAUS_MAINNET_PRIVATE_KEY;
  const mainnetClient = configuredMainnet ? createPublicClient({ transport: http(env.CLAUS_MAINNET_RPC_URL, { retryCount: 0, timeout: 15000 }) }) : null;
  const mainnetSigner = configuredMainnet ? privateKeyToAccount(env.CLAUS_MAINNET_PRIVATE_KEY) : null;
  if (mainnetSigner) requireThat(mainnetSigner.address.toLowerCase() === env.CLAUS_MAINNET_SIGNER?.toLowerCase() &&
    mainnetSigner.address.toLowerCase() !== signer.address.toLowerCase(), 'worker_signer_mismatch');
  const mainnet = configuredMainnet ? createChainRead({ client: mainnetClient, chainId: 1 }) : null;
  const chain = createReadonlyChainRouter({ sepolia, mainnet });
  const app = createApplication({ store, origin: env.CLAUS_NETWORK_ORIGIN, rateSalt: env.CLAUS_NETWORK_RATE_SALT, chainPorts: { chain } });
  const ports = new Map();
  for (const [chainId, reader, rpc, key] of [[11155111, sepolia, client, signer], [1, mainnet, mainnetClient, mainnetSigner]]) {
    if (!reader) continue;
    ports.set(chainId, role === 'controller' ? createClausController({ store, chain: reader, client: rpc, signer: key, chainId,
      secret: env.CLAUS_NETWORK_REVIEW_SECRET }) : createChainExecutor({ store, chain: reader, client: rpc, signer: key, sealer, chainId,
      artifacts: app.artifacts, admission: app.deployments.admission.forChain(chainId),
      verification: createSourceVerification({ store, etherscanKey: env.ETHERSCAN_API_KEY, chainId }) }));
  }
  const selected = value => {
    const chainId = value.proposal?.chainId ?? value.chainId ?? 11155111;
    const port = ports.get(chainId); requireThat(port, 'chain_not_configured'); return port;
  };
  const controller = { step: input => selected(input.value).step(input) };
  const executor = { deployment: { step: input => selected(input.value).deployment.step(input) },
    execution: { step: input => selected(input.value).execution.step(input) } };
  return { store, async tick() {
    // Keep reconciling already broadcast work after either admission is disabled.
    // Each dispatch/signature rechecks its own current capability and authority.
    const work = role === 'controller' ? await app.approvals.runDecision(controller) : {
      deployment: await app.deployments.runOne(executor.deployment), execution: await app.approvals.runExecution(executor.execution) };
    const result = role === 'controller' ? { decision: work.state ?? 'idle' } : {
      deployment: work.deployment.state ?? 'idle', execution: work.execution.state ?? 'idle' };
    await store.transaction(async tx => {
      const old = await tx.read('worker-health', role);
      await tx.write('worker-health', role, { ...result, chains: [...ports.keys()], observedAt: Date.now(), release: env.CLAUS_NETWORK_RELEASE }, old?.revision ?? 0);
    });
    return result;
  } };
}
