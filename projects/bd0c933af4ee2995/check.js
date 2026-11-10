#!/usr/bin/env node
// NEAR counterparty check: who created/funded this account, who pays it, and does that money trace back to itself?
// Read-only. Public data only (NEAR RPC + NearBlocks). Unknown stays unknown.
const NB = 'https://api.nearblocks.io/v1';
const RPCS = ['https://rpc.mainnet.near.org', 'https://free.rpc.fastnear.com'];

const BRIDGES = new Set(['omft.near','omni.bridge.near','bridge-mng.near','factory.bridge.near','aurora','rainbow-bridge.near']);
function isBridge(a) { return !!a && (BRIDGES.has(a) || a.endsWith('.bridge.near') || a.endsWith('.omft.near') || a.endsWith('.factory.bridge.near')); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function nb(path) {
  for (let i = 0; i < 4; i++) {
    try {
      await sleep(1500);
      const r = await fetch(NB + path, { headers: { accept: 'application/json' } });
      if (r.status === 429) { await sleep(8000 * (i + 1)); continue; }
      if (!r.ok) return { error: `http_${r.status}` };
      return await r.json();
    } catch (e) { if (i === 4) return { error: String(e.message || e) }; await sleep(1000); }
  }
  return { error: 'rate_limited' };
}

async function rpc(method, params) {
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'c', method, params }) });
      const j = await r.json();
      if (j.result) return j.result;
    } catch {}
  }
  return null;
}

const parentOf = (a) => { const i = a.indexOf('.'); return i > 0 ? a.slice(i + 1) : null; };
const PLUMBING = new Set(['system']);
const isSpamToken = (sym) => /https?:|\.app|\.com|\.io|claim|reward|visit|www/i.test(String(sym||''));
const REGISTRARS = new Set(['near','tg','testnet','sweat','kaiching']);
const related = (a, b) => !!a && !!b && !REGISTRARS.has(a) && !REGISTRARS.has(b) && (a === b || a.endsWith('.' + b) || b.endsWith('.' + a));

export async function check(account) {
  const out = { account, observedAt: new Date().toISOString(), exists: 'unknown', creator: 'unknown', creationTx: 'unknown', parent: parentOf(account), inflows: [], flags: [], unknowns: [] };
  const view = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: account });
  if (view) { out.exists = true; out.balanceYocto = view.amount; } else out.unknowns.push('view_account unavailable or account missing');

  const acc = await nb(`/account/${account}`);
  const rec = acc?.account?.[0];
  const txh = rec?.created?.transaction_hash;
  if (txh) {
    out.creationTx = txh;
    const t = await nb(`/txns/${txh}`);
    const tx = t?.txns?.[0];
    if (tx?.signer_account_id) out.creator = tx.signer_account_id;
    else {
      // RPC fallback: tx_status needs a sender for routing; try the parent, then the account.
      for (const s of [out.parent, account].filter(Boolean)) {
        const r = await rpc('EXPERIMENTAL_tx_status', { tx_hash: txh, sender_account_id: s, wait_until: 'NONE' });
        if (r?.transaction?.signer_id) { out.creator = r.transaction.signer_id; break; }
      }
      if (out.creator === 'unknown') out.unknowns.push('creator: creation tx found but signer not readable');
    }
  } else out.unknowns.push(`creation tx: ${acc?.error || 'not returned (genesis or implicit account?)'}`);

  // Inflows: fungible-token receipts where this account's balance went up.
  const ft = await nb(`/account/${account}/ft-txns?per_page=100&order=desc`);
  const by = new Map();
  if (Array.isArray(ft?.txns)) {
    for (const x of ft.txns) {
      if (!(Number(x.delta_amount) > 0)) continue;
      const from = x.involved_account_id || 'unknown';
      const sym = x.ft?.symbol || x.ft?.contract || '?';
      const dec = Number(x.ft?.decimals ?? 0);
      const k = from + '|' + sym;
      const e = by.get(k) || { from, token: sym, count: 0, amount: 0 };
      e.count++; e.amount += Number(x.delta_amount) / 10 ** dec;
      by.set(k, e);
    }
    out.ftSample = { rows: ft.txns.length, note: 'latest 100 FT events only; older history not read' };
  } else out.unknowns.push(`ft inflows: ${ft?.error || 'no data'}`);

  // NEAR inflows (best effort; NearBlocks /txns has returned 500 before).
  const nt = await nb(`/account/${account}/txns?per_page=50&order=desc`);
  if (Array.isArray(nt?.txns)) {
    for (const x of nt.txns) {
      const deposit = (x.actions || []).reduce((s, a) => s + Number(a.deposit || 0), 0);
      if (x.receiver_account_id !== account || !(deposit > 0)) continue;
      const from = x.signer_account_id || x.predecessor_account_id || 'unknown';
      const k = from + '|NEAR';
      const e = by.get(k) || { from, token: 'NEAR', count: 0, amount: 0 };
      e.count++; e.amount += deposit / 1e24; by.set(k, e);
    }
  } else out.unknowns.push(`NEAR inflows: ${nt?.error || 'no data'} (unknown, not zero)`);

  out.inflows = [...by.values()].sort((a, b) => b.count - a.count).slice(0, 15).map(e => {
    const tags = [];
    if (PLUMBING.has(e.from)) tags.push('plumbing:gas_refund');
    if (REGISTRARS.has(e.from)) tags.push('plumbing:registrar');
    if (isBridge(e.from)) tags.push('plumbing:bridge');
    if (isSpamToken(e.token)) tags.push('spam_token');
    if (e.from === account) tags.push('self');
    if (out.creator !== 'unknown' && e.from === out.creator) tags.push('creator');
    else if (related(e.from, account)) tags.push('same_family');
    if (out.creator !== 'unknown' && related(e.from, out.creator) && e.from !== out.creator) tags.push('creator_family');
    return { ...e, amount: Number(e.amount.toFixed(6)), tags: tags.length ? tags : ['outside_or_unknown'] };
  });
  const excluded = out.inflows.filter(i => i.tags.some(t => t.startsWith('plumbing') || t === 'spam_token'));
  if (excluded.length) out.excludedFromCounts = excluded.map(i => ({ from: i.from, token: i.token, count: i.count, why: i.tags.filter(t => t.startsWith('plumbing') || t === 'spam_token') }));
  const counted = out.inflows.filter(i => !excluded.includes(i));
  const insider = counted.filter(i => !i.tags.includes('outside_or_unknown'));
  const total = counted.reduce((s, i) => s + i.count, 0);
  const ins = insider.reduce((s, i) => s + i.count, 0);
  if (total) out.flags.push({ insiderShareOfSampledInflowEvents: Number((ins / total).toFixed(3)) });
  if (ins && ins === total) out.flags.push('all sampled inflows come from self/creator/same account family');
  out.verdict = !total ? 'unknown: no sampled inflows' : ins / total >= 0.5 ? 'mostly self-funded in sample' : 'mostly outside or unlabelled senders in sample (not proof of independent customers)';
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const accts = process.argv.slice(2);
  if (!accts.length) { console.error('usage: node check.mjs <account.near> [...]'); process.exit(2); }
  const res = [];
  for (const a of accts) { res.push(await check(a)); await sleep(3000); }
  console.log(JSON.stringify(res, null, 2));
}
