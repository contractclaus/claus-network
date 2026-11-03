// Account age from the public NearBlocks API. Returns ageDays:null on any failure (unknown, never 'new').
export async function accountAgeDays(accountId, now = Date.now()) {
  try {
    const r = await fetch(`https://api.nearblocks.io/v1/account/${encodeURIComponent(accountId)}`);
    if (!r.ok) return { ageDays: null, source: 'nearblocks', error: `http_${r.status}` };
    const j = await r.json();
    const acct = Array.isArray(j.account) ? j.account[0] : j.account;
    const ts = acct && acct.created && acct.created.block_timestamp;
    if (!ts) return { ageDays: null, source: 'nearblocks', error: 'no_created_timestamp' };
    const ms = Number(BigInt(String(ts)) / 1000000n);
    return { ageDays: Math.floor((now - ms) / 86400000), createdAt: new Date(ms).toISOString(), source: 'nearblocks' };
  } catch (e) {
    return { ageDays: null, source: 'nearblocks', error: String(e.message || e) };
  }
}
