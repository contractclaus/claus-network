import assert from 'node:assert/strict';
import { assess, NO_CODE } from './src/check.js';
// Old account, first small payment -> allow (info only)
assert.equal(assess({ accountId: 'shop.near', exists: true, codeHash: NO_CODE, ageDays: 900, priorInteractions: false, amount: 0.5 }).decision, 'allow');
// Young account, first payment -> warn
assert.equal(assess({ accountId: 'x.near', exists: true, codeHash: NO_CODE, ageDays: 30, priorInteractions: false, amount: 0.5 }).decision, 'warn');
// Old account, large first payment -> block
assert.equal(assess({ accountId: 'shop.near', exists: true, codeHash: NO_CODE, ageDays: 900, priorInteractions: false, amount: 5 }).decision, 'block');
// Known contract first seen, old, small -> allow
assert.equal(assess({ accountId: 'wrap.near', exists: true, codeHash: 'HashW', ageDays: 2087, priorInteractions: false, amount: 0.5 }).decision, 'allow');
// Unknown contract -> warn
assert.equal(assess({ accountId: 'odd.near', exists: true, codeHash: 'HashO', ageDays: 2000, priorInteractions: false, amount: 0.5 }).decision, 'warn');
// Known contract whose code changed -> still block
assert.equal(assess({ accountId: 'wrap.near', exists: true, codeHash: 'HashNEW', knownCodeHash: 'HashOLD', ageDays: 2087, priorInteractions: true }).decision, 'block');
// Indexer miss, first contact -> warn (not treated as established)
assert.equal(assess({ accountId: 'q.near', exists: true, codeHash: NO_CODE, ageDays: null, priorInteractions: false, amount: 0.5 }).decision, 'warn');
console.log('threshold tests passed');
