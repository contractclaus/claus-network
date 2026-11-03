import assert from 'node:assert/strict';
import { gatherFacts } from './src/enrich.js';
import { assess, NO_CODE } from './src/check.js';

const store = {};
const old = async () => ({ ageDays: 900 });
const young = async () => ({ ageDays: 2 });
const miss = async () => ({ ageDays: null, error: 'http_404' });

// Plain account, old, known payee -> allow
let f = await gatherFacts({ accountId: 'shop.near', rpc: { exists: true, codeHash: NO_CODE }, store, priorInteractions: true, amount: 0.5, fetchAge: old });
assert.equal(assess(f).decision, 'allow');
// Young account -> warn
f = await gatherFacts({ accountId: 'fresh.near', rpc: { exists: true, codeHash: NO_CODE }, store, priorInteractions: true, fetchAge: young });
assert.equal(assess(f).decision, 'warn');
assert.ok(assess(f).reasons.some(r => r.code === 'young_account'));
// Indexer miss -> allow with info reason
f = await gatherFacts({ accountId: 'quiet.near', rpc: { exists: true, codeHash: NO_CODE }, store, priorInteractions: true, fetchAge: miss });
assert.equal(assess(f).decision, 'allow');
// Contract first seen -> unknown_contract warn; same hash later -> allow; changed hash -> block
f = await gatherFacts({ accountId: 'dex.near', rpc: { exists: true, codeHash: 'HashAAAA' }, store, priorInteractions: true, fetchAge: old });
assert.equal(f.codeWatch, 'first_seen'); assert.equal(assess(f).decision, 'warn');
f = await gatherFacts({ accountId: 'dex.near', rpc: { exists: true, codeHash: 'HashAAAA' }, store, priorInteractions: true, fetchAge: old });
assert.equal(f.codeWatch, 'unchanged'); assert.equal(assess(f).decision, 'allow');
f = await gatherFacts({ accountId: 'dex.near', rpc: { exists: true, codeHash: 'HashBBBB' }, store, priorInteractions: true, fetchAge: old });
assert.equal(f.codeWatch, 'changed'); assert.equal(assess(f).decision, 'block');
assert.ok(assess(f).reasons.some(r => r.code === 'code_changed'));
console.log('enrich tests passed');
