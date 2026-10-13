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

export async function checkChainWorkerRoles(store, role, signers) {
  for(const [chainId,signer] of signers){
    const cap=(await store.read('network-capabilities',chainId===1?'chain:1':'chain'))?.value;
    if(!cap)continue;
    const expected=role==='controller'?cap.approvalSigner:cap.executorPayer;
    requireThat(expected?.toLowerCase()===signer.address.toLowerCase(),'worker_role_mismatch');
  }
}

export async function createChainWorker(role, env = process.env) {
  requireThat(['controller', 'executor'].includes(role), 'invalid_worker_role');
  // Receipt-pinned state and resumable event scans need historical data.
  // The operator must select and verify an archive RPC before activation.
  requireThat(typeof env.CLAUS_SEPOLIA_RPC_URL === 'string' &&
    new URL(env.CLAUS_SEPOLIA_RPC_URL).protocol === 'https:', 'historical_rpc_required');
  neonConfig.webSocketConstructor = ws;
  const store = await openPostgresStore({ pool: new Pool({ connectionString: env.CLAUS_NETWORK_DATABASE_URL, max: 3, connectionTimeoutMillis: 8000 }) });
  const client = createPublicClient({ transport: http(env.CLAUS_SEPOLIA_RPC_URL, { retryCount: 0, timeout: 15000 }), cacheTime: 0 });
  const signer = privateKeyToAccount(env.CLAUS_CHAIN_PRIVATE_KEY);
  requireThat(signer.address.toLowerCase() === env.CLAUS_CHAIN_SIGNER?.toLowerCase(), 'worker_signer_mismatch');
  const sepolia = createChainRead({ client }), sealer = createSealer(env.CLAUS_NETWORK_SEALING_KEY);
  const configuredMainnet = !!env.CLAUS_MAINNET_RPC_URL && !!env.CLAUS_MAINNET_PRIVATE_KEY;
  if(env.CLAUS_MAINNET_RPC_URL||env.CLAUS_MAINNET_PRIVATE_KEY||env.CLAUS_MAINNET_SIGNER){
    requireThat(configuredMainnet&&!!env.CLAUS_MAINNET_SIGNER,'incomplete_mainnet_worker');
    requireThat(new URL(env.CLAUS_MAINNET_RPC_URL).protocol==='https:','invalid_mainnet_rpc');
  }
  const mainnetClient = configuredMainnet ? createPublicClient({ transport: http(env.CLAUS_MAINNET_RPC_URL, { retryCount: 0, timeout: 15000 }) }) : null;
  const mainnetSigner = configuredMainnet ? privateKeyToAccount(env.CLAUS_MAINNET_PRIVATE_KEY) : null;
  if (mainnetSigner) requireThat(mainnetSigner.address.toLowerCase() === env.CLAUS_MAINNET_SIGNER?.toLowerCase() &&
    mainnetSigner.address.toLowerCase() !== signer.address.toLowerCase(), 'worker_signer_mismatch');
  const mainnet = configuredMainnet ? createChainRead({ client: mainnetClient, chainId: 1 }) : null;
  const chain = createReadonlyChainRouter({ sepolia, mainnet });
  const app = createApplication({ store, origin: env.CLAUS_NETWORK_ORIGIN, rateSalt: env.CLAUS_NETWORK_RATE_SALT, chainPorts: { chain, client, mainnetClient } });
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
  const preflight = value => { selected(value); };
  const controller = { preflight, step: input => selected(input.value).step(input) };
  const executor = { deployment: { preflight, step: input => selected(input.value).deployment.step(input) },
    execution: { preflight, step: input => selected(input.value).execution.step(input) } };
  return { store, async tick() {
    await checkChainWorkerRoles(store,role,[[11155111,signer],...(mainnetSigner?[[1,mainnetSigner]]:[])]);
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
