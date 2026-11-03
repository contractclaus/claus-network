import assert from 'node:assert/strict';
import { assess } from './src/check.js';

const base = { exists: true, priorInteractions: false, amount: 0.5, codeHash: '11111111111111111111111111111111' };

// Age unknown + heavy history + small amount: first_contact is info, verdict allow.
let r = assess({ ...base, accountId: 'busy.testnet', ageDays: null, txCount: 33000000 });
assert.equal(r.decision, 'allow', JSON.stringify(r));
assert.ok(r.reasons.some(x => x.code === 'first_contact' && x.level === 'info'));
assert.ok(r.reasons.some(x => x.code === 'age_unknown' && x.level === 'info'));

// Age unknown + thin history: still warn on first contact.
r = assess({ ...base, accountId: 'thin.testnet', ageDays: null, txCount: 12 });
assert.equal(r.decision, 'warn');

// Age unknown + activity unknown: both unknown, still warn (no evidence either way), never block.
r = assess({ ...base, accountId: 'dark.testnet', ageDays: null, txCount: null });
assert.equal(r.decision, 'warn');

// Heavy history does not excuse a large first payment.
r = assess({ ...base, accountId: 'busy.testnet', ageDays: null, txCount: 5000, amount: 50 });
assert.equal(r.decision, 'block');

// Heavy history does not suppress code-change protection.
r = assess({ ...base, accountId: 'busy.testnet', ageDays: null, txCount: 5000, codeHash: 'bbbbbbbbbb', knownCodeHash: 'aaaaaaaaaa', priorInteractions: true });
assert.equal(r.decision, 'block');

// Known age still wins over the txCount fallback: young account warns.
r = assess({ ...base, accountId: 'young.testnet', ageDays: 2, txCount: 5000 });
assert.equal(r.decision, 'warn');

console.log('test_history: 6/6 ok');
