import assert from 'node:assert/strict';
import { assess, NO_CODE } from './src/check.js';
import { guardedPay, scopedSigner } from './src/wrapper.js';

const base = { accountId: 'shop.near', exists: true, codeHash: NO_CODE, ageDays: 400, priorInteractions: true, amount: 0.5 };
assert.equal(assess(base).decision, 'allow');
assert.equal(assess({ ...base, exists: false }).decision, 'block');
assert.equal(assess({ ...base, blocklisted: { evidence: 'tx 9xY' } }).decision, 'block');
assert.equal(assess({ ...base, ageDays: 2 }).decision, 'warn');
assert.equal(assess({ ...base, ageDays: null }).decision, 'allow');
assert.ok(assess({ ...base, ageDays: null }).reasons.some(r => r.code === 'age_unknown' && r.level === 'info'));
assert.equal(assess({ ...base, priorInteractions: false, amount: 5 }).decision, 'block');
assert.equal(assess({ ...base, codeHash: 'Bbbbbbbb', knownCodeHash: 'Aaaaaaaa' }).decision, 'block');
assert.equal(assess({ ...base, codeHash: 'Cccccccc' }).decision, 'warn');

const log = [];
const signer = scopedSigner({ receiverId: 'usdc.near', methodNames: ['ft_transfer'] });
const blocked = guardedPay({ facts: { ...base, exists: false }, signer, action: { receiverId: 'usdc.near', method: 'ft_transfer' }, log });
assert.equal(blocked.ok, false); assert.equal(log.at(-1).outcome, 'refused_to_sign');
const ok = guardedPay({ facts: base, signer, action: { receiverId: 'usdc.near', method: 'ft_transfer' }, log });
assert.equal(ok.ok, true);
const scope = guardedPay({ facts: base, signer, action: { receiverId: 'other.near', method: 'ft_transfer' }, log });
assert.equal(scope.ok, false); assert.equal(log.at(-1).outcome, 'key_scope_refused');
console.log('all tests passed:', log.map(l => l.outcome).join(', '));
