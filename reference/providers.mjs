import { createHash } from 'node:crypto';

const string = maxLength => ({ type: 'string', maxLength });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const status = { ...string(8), enum: ['ok', 'probe', 'error'] };
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
export const balanceSchema = object({ status, chainId: { type: 'integer', minimum: 11155111, maximum: 11155111 },
  address: string(42), balanceWei: string(80), blockNumber: count, blockHash: string(66), observedAt: count, message: string(160) });
export const definitions = {
  data: { name: 'Claus Chain Data', capability: 'chain.sepolia.balance', version: '1.0.0',
    inputSchema: object({ address: string(42) }), outputSchema: balanceSchema },
  report: { name: 'Claus Balance Report', capability: 'report.sepolia.balance', version: '1.0.0',
    inputSchema: object({ balance: balanceSchema }),
    outputSchema: object({ status, html: string(16000), inputSha256: string(64), message: string(160) }) }
};
const RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const uintPattern = /^0x[0-9a-fA-F]{1,64}$/;
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function baseBalance(state, now, message = '') {
  return { status: state, chainId: 11155111, address: '', balanceWei: '', blockNumber: 0, blockHash: '', observedAt: now(), message };
}
async function rpc(method, params, request) {
  const response = await request(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), redirect: 'error', signal: AbortSignal.timeout(12000) });
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 131072) throw Error('data_unavailable');
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length;
    if (size > 131072) throw Error('data_unavailable'); chunks.push(value); } } finally { await reader.cancel(); }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (value.error || value.id !== 1 || !Object.hasOwn(value, 'result')) throw Error('data_unavailable');
  return value.result;
}
export async function executeData(input, { purpose, request = fetch, now = Date.now } = {}) {
  if (purpose === 'conformance') return baseBalance('probe', now, 'Transport probe; no chain observation.');
  if (!addressPattern.test(input.address)) return baseBalance('error', now, 'Invalid Ethereum address.');
  const chainId = await rpc('eth_chainId', [], request);
  if (chainId.toLowerCase() !== '0xaa36a7') throw Error('chain_mismatch');
  const block = await rpc('eth_getBlockByNumber', ['finalized', false], request);
  if (!block || !hashPattern.test(block.hash) || !uintPattern.test(block.number) || BigInt(block.number) > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('invalid_block');
  const balance = await rpc('eth_getBalance', [input.address, block.number], request);
  if (!uintPattern.test(balance)) throw Error('invalid_balance');
  const confirmed = await rpc('eth_getBlockByNumber', [block.number, false], request);
  if (confirmed?.hash?.toLowerCase() !== block.hash.toLowerCase()) throw Error('block_changed');
  return { ...baseBalance('ok', now), address: input.address, balanceWei: BigInt(balance).toString(),
    blockNumber: Number(BigInt(block.number)), blockHash: block.hash };
}
export function executeReport(input, { purpose } = {}) {
  const inputSha256 = createHash('sha256').update(canonical(input)).digest('hex');
  if (purpose === 'conformance') return { status: 'probe', html: '', inputSha256, message: 'Transport probe; no published report.' };
  const b = input.balance;
  if (b?.status !== 'ok' || b.chainId !== 11155111 || !addressPattern.test(b.address) || !hashPattern.test(b.blockHash) ||
      !/^(0|[1-9][0-9]{0,77})$/.test(b.balanceWei) || BigInt(b.balanceWei) > 2n ** 256n - 1n ||
      !Number.isSafeInteger(b.blockNumber) || b.blockNumber < 0) {
    return { status: 'error', html: '', inputSha256, message: 'A valid Sepolia balance observation is required.' };
  }
  const n = BigInt(b.balanceWei), eth = (n / 10n ** 18n).toString() + '.' + (n % 10n ** 18n).toString().padStart(18, '0');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Claus | Sepolia balance</title><style>
*{box-sizing:border-box}body{margin:0;background:#ff7832;color:#17140f;font-family:Arial,Helvetica,sans-serif;min-height:100svh;padding:clamp(22px,5vw,72px);display:flex;flex-direction:column}header{display:flex;justify-content:space-between;gap:20px;align-items:baseline;font-size:18px}header strong{font-size:28px;letter-spacing:-1px}main{width:min(100%,1000px);margin:auto;padding:64px 0}h1{font-size:clamp(38px,7vw,84px);line-height:1.03;letter-spacing:-.05em;margin:0 0 36px}.value{font-size:clamp(24px,5vw,58px);font-weight:700;overflow-wrap:anywhere;margin:0 0 40px}dl{border-top:1px solid #17140f;margin:0}dl div{display:grid;grid-template-columns:140px 1fr;gap:20px;border-bottom:1px solid #17140f;padding:20px 0}dt{font-size:14px}dd{margin:0;font-family:monospace;overflow-wrap:anywhere}footer{font-size:13px}@media(max-width:500px){dl div{grid-template-columns:1fr;gap:9px}main{padding:48px 0}.value{font-size:26px}}
</style></head><body><header><strong>Claus</strong><span>Sepolia</span></header><main><h1>Wallet balance</h1><p class="value">${eth} ETH</p><dl><div><dt>Address</dt><dd>${b.address}</dd></div><div><dt>Finalized block</dt><dd>${b.blockNumber}</dd></div><div><dt>Block hash</dt><dd>${b.blockHash}</dd></div></dl></main><footer>Ethereum testnet · No market value</footer></body></html>`;
  return { status: 'ok', html, inputSha256, message: '' };
}

// Separate deployments receive separate project credentials. Both reference
// services are operated by Claus; they are not evidence of independent adoption.
export function createReferenceWorker({ role, client, projectId, serviceId, request, now = Date.now }) {
  if (!definitions[role] || !projectId || !serviceId) throw Error('invalid_reference_configuration');
  return { async tick() {
    let after = '', delivered = 0, pages = 0;
    do {
      const page = await client.call('provider_orders', { projectId, ...(after ? { after } : {}), limit: 100 });
      for (const order of page.orders) {
        if (order.serviceId !== serviceId || order.leaseUntil > now()) continue;
        let claim;
        try { claim = await client.call('provider_claim', { projectId, orderId: order.id }); }
        catch (error) { if (error.code === 'service_order_busy') continue; throw error; }
        if (claim.state !== 'working') continue;
        const output = role === 'data' ? await executeData(claim.input, { purpose: claim.purpose, request, now }) : executeReport(claim.input, { purpose: claim.purpose });
        await client.call('provider_deliver', { projectId, orderId: order.id, lease: claim.lease, output });
        if (++delivered === 4) return { state: 'ready', delivered };
      }
      after = page.nextCursor;
    } while (after && ++pages < 10);
    return { state: 'ready', delivered };
  } };
}
