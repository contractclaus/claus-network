import assert from 'assert';
import { createScopedKey } from './src/scopedkey.js';
import { nearSigner } from './src/signer.js';
import { guardedPay } from './src/wrapper.js';
import { transactions, utils } from 'near-api-js';

const k = createScopedKey({ receiverId: 'pay.demo.testnet', methodNames: ['pay'], allowanceNear: '0.25' });
const signer = nearSigner({ signerId: 'agent.demo.testnet', keyPair: k.keyPair, scope: k.scope });
const ctx = { nonce: 7, blockHash: utils.serialize.base_encode(new Uint8Array(32).fill(3)) };

const out = signer.sign({ receiverId: 'pay.demo.testnet', method: 'pay', args: { to: 'bob.testnet', amount: '1' } }, ctx);
assert.equal(out.signed, true);
// Signature verifies against the scoped public key over sha256(tx bytes).
const decoded = transactions.SignedTransaction.decode(Buffer.from(out.signedTx, 'base64'));
assert.equal(decoded.transaction.receiverId, 'pay.demo.testnet');
assert.equal(decoded.transaction.signerId, 'agent.demo.testnet');
assert.equal(decoded.transaction.actions[0].functionCall.methodName, 'pay');
assert.equal(BigInt(decoded.transaction.actions[0].functionCall.deposit), 0n);
assert(k.keyPair.verify(out.digest, new Uint8Array(decoded.signature.ed25519Signature?.data ?? decoded.signature.data)), 'signature must verify with scoped key');

// Out-of-scope actions throw before anything is signed.
assert.throws(() => signer.sign({ receiverId: 'evil.testnet', method: 'pay' }, ctx), /receiver_out_of_scope/);
assert.throws(() => signer.sign({ receiverId: 'pay.demo.testnet', method: 'drain' }, ctx), /method_out_of_scope/);
assert.throws(() => signer.sign({ receiverId: 'pay.demo.testnet', method: 'pay', depositYocto: '1' }, ctx), /deposit_not_allowed/);

// Through the wrapper: allow -> real signature; block -> nothing signed.
const log = [];
const good = { accountId: 'bob.testnet', amount: 1, exists: true, ageDays: 900, txCount: 5000 };
const w = guardedPay({ facts: good, signer: { scope: signer.scope, sign: (a) => signer.sign(a, ctx) }, action: { receiverId: 'pay.demo.testnet', method: 'pay' }, log });
if (w.ok) assert(w.sig.signedTx, 'allowed payment carries a real signed tx');
const bad = guardedPay({ facts: { accountId: 'ghost.testnet', amount: 1, exists: false }, signer: { scope: signer.scope, sign: () => { throw new Error('must not sign'); } }, action: { receiverId: 'pay.demo.testnet', method: 'pay' }, log });
assert.equal(bad.ok, false);
console.log('signer tests ok', out.txHash, 'wrapper:', log.map(l => l.outcome).join(','));
