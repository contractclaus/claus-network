import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';
import { openStore } from '../src/storage/index.mjs';
import { createImdPayment } from '../adapters/imd-payment.mjs';
import { IMD_REVIEW } from '../adapters/imd.mjs';
import { createSealer } from '../adapters/secrets.mjs';
import { digest } from '../src/shared/index.mjs';

test('real typed signatures bind both the bounded permit and exact payment to the quote; unknown sends are not retried', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  const signer = privateKeyToAccount(generatePrivateKey()), sealer = createSealer('11'.repeat(32));
  const time = Date.now(), offerId = 'review-order-one';
  const resource = { url: IMD_REVIEW.origin + '/requests/' + offerId };
  const payment = { scheme: 'exact', network: IMD_REVIEW.network, asset: IMD_REVIEW.asset, amount: IMD_REVIEW.maximum, payTo: IMD_REVIEW.payTo };
  const challenge = { resource, resourceUrl: resource.url, requesterScopeHash: 'ab'.repeat(32),
    accepts: [{ ...payment, maxTimeoutSeconds: 300, extra: { assetTransferMethod: 'permit2' } }],
    quote: { id: offerId, action: 'job.open', quoteHash: 'cd'.repeat(32), expiresAt: Math.floor(time / 1000) + 600, payment } };
  let sends = 0, permitted = true;
  const signed = [];
  const api = createImdPayment({ store, sealer, signer: { address: signer.address, signTypedData: async typed => {
    signed.push(typed); return signer.signTypedData(typed);
  } }, provider: { challenge: async () => challenge, submit: async (_, material) => {
    sends++; const parsed = JSON.parse(Buffer.from(material.paymentSignature, 'base64'));
    assert.equal(parsed.payload.permit2Authorization.nonce, signed[0].message.nonce.toString());
    assert.equal(parsed.payload.permit2Authorization.deadline, signed[0].message.deadline.toString());
    assert.equal(signed[1].message.paymentHash, '0x' + digest(parsed).slice(7));
    assert.equal((await recoverTypedDataAddress({ ...signed[0], signature: parsed.payload.signature })).toLowerCase(), signer.address.toLowerCase());
    throw Error('response lost after payment');
  }, status: async () => ({ status: 'admitted', payment: { paid: true, transactionHash: '0x' + '34'.repeat(32) } }) },
  authorize: async (_, tx) => { assert.ok(tx); return permitted; }, now: () => time });
  assert.equal((await api.prepare(offerId)).state, 'prepared');
  assert.equal((await api.prepare(offerId)).state, 'prepared'); assert.equal(signed.length, 2);
  permitted = false;
  await assert.rejects(api.submit(offerId), { code: 'payment_not_authorized' }); assert.equal(sends, 0);
  permitted = true;
  assert.equal((await api.submit(offerId)).state, 'outcome_unknown');
  assert.equal((await api.submit(offerId)).state, 'outcome_unknown'); assert.equal(sends, 1);
  assert.equal((await api.reconcile(offerId)).state, 'provider_paid'); assert.equal(sends, 1);
  const stored = JSON.stringify((await store.read('imd-payments', offerId)).value);
  assert.equal(stored.includes('quoteSignature'), false); assert.equal(stored.includes('paymentSignature'), false);
});
