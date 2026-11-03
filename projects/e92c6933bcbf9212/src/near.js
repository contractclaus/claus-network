// Live facts from NEAR JSON-RPC plus account age from the NearBlocks indexer.
// Indexer failure leaves ageDays null (reported as age_unknown, never as new).
const RPC = process.env.NEAR_RPC || 'https://rpc.mainnet.near.org';
const INDEXER = process.env.NEAR_INDEXER || 'https://api.nearblocks.io/v1/account/';

export async function viewAccount(accountId) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'cc', method: 'query',
      params: { request_type: 'view_account', finality: 'final', account_id: accountId } })
  });
  const j = await res.json();
  if (j.error) {
    const name = j.error?.cause?.name;
    if (name === 'UNKNOWN_ACCOUNT') return { exists: false, block: null };
    throw new Error(`rpc_error ${name || j.error.message}`);
  }
  return { exists: true, codeHash: j.result.code_hash, block: j.result.block_height, amountYocto: j.result.amount };
}

export async function accountAgeDays(accountId, now = Date.now()) {
  try {
    const ctl = AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined;
    const res = await fetch(INDEXER + encodeURIComponent(accountId), { signal: ctl });
    if (!res.ok) return null;
    const j = await res.json();
    const ns = j?.account?.[0]?.created?.block_timestamp;
    if (ns == null) return null;
    const ms = Number(BigInt(String(ns)) / 1000000n);
    return Math.floor((now - ms) / 86400000);
  } catch { return null; }
}

export async function gatherFacts(accountId, memory, amount) {
  const acct = await viewAccount(accountId);
  const prior = memory.interactions[accountId];
  const ageDays = acct.exists ? await accountAgeDays(accountId) : null;
  return {
    accountId, amount, ...acct,
    ageDays,
    priorInteractions: Boolean(prior),
    knownCodeHash: prior?.codeHash ?? null,
    blocklisted: memory.blocklist[accountId] ?? null
  };
}
