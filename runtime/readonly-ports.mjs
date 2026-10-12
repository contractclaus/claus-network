import { createPublicClient, http } from 'viem';
import { requireThat } from '../src/shared/index.mjs';

// Read-only RPC configuration is not permission to spend or launch contracts.
export function readonlyPorts(env = process.env) {
  if (!env.CLAUS_MAINNET_RPC_URL) return {};
  const url = new URL(env.CLAUS_MAINNET_RPC_URL);
  requireThat(url.protocol === 'https:', 'invalid_mainnet_rpc');
  return { mainnetClient: createPublicClient({ transport: http(url.href, { retryCount: 0, timeout: 15000 }), cacheTime: 0 }) };
}
