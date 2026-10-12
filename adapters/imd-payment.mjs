import { randomBytes } from 'node:crypto';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { recoverTypedDataAddress } from 'viem';
import { amount, canonical, copy, digest, requireThat } from '../src/shared/index.mjs';
import { IMD_REVIEW } from './imd.mjs';

export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
export const PAYMENT_PROXY = '0x402085c248eea27d92e8b30b2c58ed07f9e20001';
const fields = values => values.map(([name, type]) => ({ name, type }));
const PERMIT_TYPES = { PermitWitnessTransferFrom: fields([['permitted', 'TokenPermissions'], ['spender', 'address'], ['nonce', 'uint256'], ['deadline', 'uint256'], ['witness', 'Witness']]),
  TokenPermissions: fields([['token', 'address'], ['amount', 'uint256']]), Witness: fields([['to', 'address'], ['validAfter', 'uint256']]) };
const QUOTE_TYPES = { QuoteApproval: fields([['resource', 'string'], ['requesterScopeHash', 'bytes32'], ['quoteId', 'string'], ['quoteHash', 'bytes32'], ['paymentHash', 'bytes32'], ['action', 'string'], ['asset', 'address'], ['amount', 'uint256'], ['payTo', 'address'], ['expiresAt', 'uint256']]) };
const safeJson = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item));

// Private worker component, never an API signing endpoint. Admission must bind
// this exact offer to a funded reservation before authorize returns true.
export function createImdPayment({ store, sealer, provider, signer, authorize = async () => false, now = () => Date.now() }) {
  const summary = value => ({ id: value.id, offerId: value.offerId, state: value.state, amount: value.amount,
    payer: value.payer, updatedAt: value.updatedAt, outcome: value.outcome ?? null });
  const seconds = () => Math.floor(now() / 1000);
  async function sign(typed) {
    const signature = await signer.signTypedData(typed);
    requireThat((await recoverTypedDataAddress({ ...typed, signature })).toLowerCase() === signer.address.toLowerCase(), 'invalid_signer_result');
    return signature;
  }
  async function update(offerId, expected, fn) {
    return store.transaction(async tx => {
      const old = await tx.read('imd-payments', offerId);
      requireThat(old && old.value.state === expected, 'payment_state_conflict');
      const value = { ...await fn(old.value, tx), updatedAt: now() };
      await tx.write('imd-payments', offerId, value, old.revision); return value;
    });
  }
  return {
    // Called only inside the workflow's fenced transaction. No state after
    // submit intent is reversible here, even if the provider says unpaid.
    async abandonUnsent(tx, offerId) {
      const old = await tx.read('imd-payments', offerId);
      if (!old || old.value.state === 'cancelled') return true;
      if (!['signing', 'signing_unknown', 'prepared'].includes(old.value.state)) return false;
      const { sealedMaterial, sealedIntent, ...record } = old.value;
      await tx.write('imd-payments', offerId, { ...record, state: 'cancelled', updatedAt: now() }, old.revision);
      return true;
    },
    async prepare(offerId) {
      const previous = await store.read('imd-payments', offerId);
      if (previous) return summary(previous.value);
      const challenge = await provider.challenge(offerId), q = challenge.quote, accepted = challenge.accepts[0];
      requireThat(q.expiresAt > seconds() + 60 && q.payment.amount === accepted.amount, 'payment_window_expired');
      const n = amount(q.payment.amount);
      requireThat(n > 0n && n <= amount(IMD_REVIEW.maximum), 'payment_limit');
      const payer = signer.address.toLowerCase();
      const deadline = Math.min(seconds() + 300, q.expiresAt - 5);
      const record = await store.transaction(async tx => {
        requireThat(await authorize({ offerId, challenge: copy(challenge), payer, amount: q.payment.amount }, tx) === true, 'payment_not_authorized');
        const old = await tx.read('imd-payments', offerId);
        if (old) return null;
        const value = { id: offerId, offerId, state: 'signing', payer, amount: q.payment.amount,
          nonce: BigInt('0x' + randomBytes(32).toString('hex')).toString(), deadline,
          challengeHash: digest(challenge), updatedAt: now() };
        await tx.write('imd-payments', offerId, value, 0); return value;
      });
      if (!record) return summary((await store.read('imd-payments', offerId)).value);
      try {
        const generated = await new ExactEvmScheme({ address: signer.address, signTypedData: async input => {
          requireThat(input.primaryType === 'PermitWitnessTransferFrom' && canonical(input.types) === canonical(PERMIT_TYPES) &&
            input.domain.name === 'Permit2' && input.domain.chainId === 1 && input.domain.verifyingContract.toLowerCase() === PERMIT2, 'invalid_payment_typed_data');
          const m = input.message;
          requireThat(m.permitted.token.toLowerCase() === IMD_REVIEW.asset && m.permitted.amount === n &&
            m.spender.toLowerCase() === PAYMENT_PROXY && m.witness.to.toLowerCase() === IMD_REVIEW.payTo &&
            m.witness.validAfter === 0n, 'invalid_payment_typed_data');
          const typed = { ...input, message: { ...m, nonce: BigInt(record.nonce), deadline: BigInt(deadline) } };
          await update(offerId, 'signing', old => ({ ...old, sealedIntent: sealer.seal(offerId, safeJson(typed)) }));
          return sign(typed);
        } }).createPaymentPayload(2, accepted);
        requireThat(!generated.extensions, 'payment_extensions_forbidden');
        generated.payload.permit2Authorization.nonce = record.nonce;
        generated.payload.permit2Authorization.deadline = String(deadline);
        const payment = { x402Version: 2, resource: challenge.resource, accepted, payload: generated.payload };
        const paymentHash = digest(payment).slice(7);
        const quoteTyped = { domain: { name: 'IdentityMD Paid Action', version: '1', chainId: 1 }, types: QUOTE_TYPES,
          primaryType: 'QuoteApproval', message: { resource: challenge.resourceUrl, requesterScopeHash: '0x' + challenge.requesterScopeHash,
            quoteId: q.id, quoteHash: '0x' + q.quoteHash, paymentHash: '0x' + paymentHash, action: q.action,
            asset: q.payment.asset, amount: n, payTo: q.payment.payTo, expiresAt: BigInt(q.expiresAt) } };
        requireThat(seconds() < deadline, 'payment_window_expired');
        const quoteSignature = await sign(quoteTyped);
        const material = { paymentSignature: Buffer.from(JSON.stringify(payment)).toString('base64'), quoteSignature };
        return summary(await update(offerId, 'signing', old => ({ ...old, state: 'prepared',
          paymentHash, sealedMaterial: sealer.seal(offerId, material) })));
      } catch (error) {
        await update(offerId, 'signing', old => ({ ...old, state: 'signing_unknown' })).catch(() => {});
        throw Object.assign(Error('payment_signing_unknown'), { code: 'payment_signing_unknown' });
      }
    },
    async submit(offerId) {
      const existing = await store.read('imd-payments', offerId);
      requireThat(existing, 'payment_missing');
      if (existing.value.state !== 'prepared') return summary(existing.value);
      const value = await update(offerId, 'prepared', async (old, tx) => {
        requireThat(old.deadline > seconds(), 'payment_window_expired');
        requireThat(await authorize({ offerId, payer: old.payer, amount: old.amount, challengeHash: old.challengeHash, phase: 'submit' }, tx) === true, 'payment_not_authorized');
        return { ...old, state: 'submitting' };
      });
      const material = sealer.open(offerId, value.sealedMaterial);
      try {
        const outcome = await provider.submit(offerId, material);
        return summary(await update(offerId, 'submitting', old => ({ ...old, state: 'submitted', outcome })));
      } catch {
        return summary(await update(offerId, 'submitting', old => ({ ...old, state: 'outcome_unknown' })));
      }
    },
    async reconcile(offerId) {
      const old = await store.read('imd-payments', offerId);
      requireThat(old, 'payment_missing');
      const outcome = await provider.status(offerId);
      // A provider status is observation, not a verified cost receipt. Neither
      // a failed job nor a missing result erases the original reservation.
      return summary(await update(offerId, old.value.state, value => ({ ...value, outcome,
        state: outcome.payment?.paid === true ? 'provider_paid' : value.state })));
    },
    async status(offerId) {
      const record = await store.read('imd-payments', offerId); return record ? summary(record.value) : null;
    }
  };
}
