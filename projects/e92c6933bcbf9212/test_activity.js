import assert from 'node:assert/strict';
import { accountTxCount } from './src/activity.js';
import { gatherFacts } from './src/enrich.js';
import { assess, NO_CODE } from './src/check.js';

const ok = (body) => async () => ({ ok: true, json: async () => body });
assert.deepEqual(await accountTxCount('a.near', { fetchImpl: ok({ txns: [{ count: '42' }] }) }), { txCount: 42, source: 'nearblocks' });
assert.equal((await accountTxCount('a.near', { fetchImpl: async () => ({ ok: false, status: 429 }) })).txCount, null);
assert.equal((await accountTxCount('a.near', { fetchImpl: async () => { throw new Error('dns'); } })).txCount, null);
assert.equal((await accountTxCount('a.near', { fetchImpl: ok({}) })).error, 'no_count');

const store = {};
const old = async () => ({ ageDays: 900 });
const rpc = { exists: true, codeHash: NO_CODE };
// Established account with history -> allow, no activity reason
let f = await gatherFacts({ accountId: 'shop.near', rpc, store, priorInteractions: true, fetchAge: old, fetchTxCount: async () => ({ txCount: 120 }) });
assert.equal(f.txCount, 120); assert.equal(assess(f).decision, 'allow');
// Zero history -> warn no_history
f = await gatherFacts({ accountId: 'empty.near', rpc, store, priorInteractions: true, fetchAge: old, fetchTxCount: async () => ({ txCount: 0 }) });
assert.equal(assess(f).decision, 'warn'); assert.ok(assess(f).reasons.some(r => r.code === 'no_history'));
// Thin history -> info only
f = await gatherFacts({ accountId: 'thin.near', rpc, store, priorInteractions: true, fetchAge: old, fetchTxCount: async () => ({ txCount: 2 }) });
assert.equal(assess(f).decision, 'allow'); assert.ok(assess(f).reasons.some(r => r.code === 'thin_history' && r.level === 'info'));
// Indexer miss -> info activity_unknown, never treated as inactive
f = await gatherFacts({ accountId: 'q.near', rpc, store, priorInteractions: true, fetchAge: old, fetchTxCount: async () => ({ txCount: null }) });
assert.equal(assess(f).decision, 'allow'); assert.ok(assess(f).reasons.some(r => r.code === 'activity_unknown'));
console.log('activity tests passed');
