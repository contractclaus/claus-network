import { createPublicClient, fallback, http } from 'viem';
import { requireThat } from '../src/shared/index.mjs';

// Read-only RPC configuration is not permission to spend or launch contracts.
export function readonlyPorts(env = process.env) {
  const primary = new URL(env.CLAUS_SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com');
  requireThat(primary.protocol === 'https:', 'invalid_sepolia_rpc');
  const backup = primary.hostname === 'sepolia.drpc.org'
    ? 'https://ethereum-sepolia-rpc.publicnode.com' : 'https://sepolia.drpc.org';
  const ports = { client: createPublicClient({
    transport: fallback([primary.href, backup].map(url => http(url, { retryCount: 0, timeout: 5000 })),
      { retryCount: 0, rank: false }), cacheTime: 0
  }) };
  if (!env.CLAUS_MAINNET_RPC_URL) return ports;
  const url = new URL(env.CLAUS_MAINNET_RPC_URL);
  requireThat(url.protocol === 'https:', 'invalid_mainnet_rpc');
  const urls = [...new Set([url.href, 'https://ethereum-rpc.publicnode.com/'])];
  ports.mainnetClient = createPublicClient({ transport: fallback(urls.map(endpoint =>
    http(endpoint, { retryCount: 0, timeout: 5000 })), { retryCount: 0, rank: false }), cacheTime: 0 });
  return ports;
}
