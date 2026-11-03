// Transaction count from the public NearBlocks API. Returns txCount:null on any failure (unknown, never 'inactive').
export async function accountTxCount(accountId, { fetchImpl = fetch, base = process.env.NEAR_INDEXER_BASE || 'https://api.nearblocks.io/v1/account/' } = {}) {
  try {
    const r = await fetchImpl(`${base}${encodeURIComponent(accountId)}/txns/count`);
    if (!r.ok) return { txCount: null, source: 'nearblocks', error: `http_${r.status}` };
    const j = await r.json();
    const raw = Array.isArray(j.txns) ? j.txns[0]?.count : j.txns?.count ?? j.count;
    if (raw == null || Number.isNaN(Number(raw))) return { txCount: null, source: 'nearblocks', error: 'no_count' };
    return { txCount: Number(raw), source: 'nearblocks' };
  } catch (e) {
    return { txCount: null, source: 'nearblocks', error: String(e.message || e) };
  }
}
