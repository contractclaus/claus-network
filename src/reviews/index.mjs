import { amount, authorize, contentHash, copy, digest, integer, requireThat, shape, text } from '../shared/index.mjs';
import { price, reserve, settleReservation } from '../billing/index.mjs';
const ref = policy => ({
    version: policy.version, hash: policy.hash, generation: policy.generation
});
export function createReviews({ store, policies, provider, verifyCost, authorize: check, now }) {
    async function find(reader, collection, id, projectId) {
        const record = (await reader.read(collection, id));
        requireThat(record?.value.projectId === projectId, 'not_found');
        return record;
    }
    return {
        async quote({ actor, id, projectId, inputHash }) {
            text(id);
            text(projectId);
            contentHash(inputHash);
            (await authorize(check, actor, 'review.quote', { projectId }));
            requireThat(provider && typeof provider.quote === 'function', 'provider_not_configured');
            const requestHash = digest({ projectId, inputHash, provider: text(provider.id) });
            const previous = (await store.read('review-quotes', id));
            if (previous) {
                requireThat(previous.value.projectId === projectId, 'not_found');
                requireThat(previous.value.requestHash === requestHash, 'idempotency_conflict');
                return previous.value;
            }
            // The adapter obtains a quote only. No provider execution happens here.
            const offer = copy(await provider.quote({ projectId, inputHash, quoteId: id }));
            shape(offer, ['id', 'provider', 'asset', 'maximum', 'expiresAt', 'inputHash']);
            text(offer.id);
            text(offer.asset);
            amount(offer.maximum);
            integer(offer.expiresAt);
            requireThat(offer.provider === provider.id && offer.inputHash === inputHash, 'provider_quote_mismatch');
            requireThat(offer.expiresAt > now(), 'quote_expired');
            // A revoked caller cannot commit a quote after the adapter wait.
            (await authorize(check, actor, 'review.quote', { projectId }));
            return store.transaction(async (tx) => {
                await authorize(check, actor, 'review.quote', { projectId }, tx);
                const existing = (await tx.read('review-quotes', id));
                if (existing) {
                    requireThat(existing.value.projectId === projectId, 'not_found');
                    requireThat(existing.value.requestHash === requestHash, 'idempotency_conflict');
                    return existing.value;
                }
                const fees = (await policies.active('review.fees', tx));
                const sponsorship = (await policies.active('review.sponsorship', tx));
                const sponsored = sponsorship.config.enabled && sponsorship.config.capabilities.includes('review.code');
                const quote = {
                    id, projectId, inputHash, requestHash, offer,
                    policyRefs: { fees: ref(fees), sponsorship: ref(sponsorship) },
                    feeTerms: fees.config, sponsored,
                    sponsorAccount: sponsored ? 'sponsor:' + sponsorship.config.payer.toLowerCase() : null,
                    projectAccount: 'project:' + projectId,
                    maximum: price({ providerAmount: offer.maximum, asset: offer.asset, fees: fees.config, sponsored })
                };
                (await tx.write('review-quotes', id, quote, 0));
                (await tx.event({ type: 'review.quoted', quoteId: id, projectId, policyRefs: quote.policyRefs, at: now() }));
                return copy(quote);
            });
        },
        async admit({ actor, projectId, quoteId, inputHash, idempotencyKey }) {
            text(projectId);
            text(quoteId);
            contentHash(inputHash);
            text(idempotencyKey);
            (await authorize(check, actor, 'review.admit', { projectId }));
            const id = digest({ projectId, idempotencyKey });
            const requestHash = digest({ projectId, quoteId, inputHash });
            return store.transaction(async (tx) => {
                await authorize(check, actor, 'review.admit', { projectId }, tx);
                const old = (await tx.read('review-jobs', id));
                if (old) {
                    requireThat(old.value.requestHash === requestHash, 'idempotency_conflict');
                    return old.value;
                }
                const quote = (await find(tx, 'review-quotes', quoteId, projectId)).value;
                requireThat(quote.inputHash === inputHash, 'quote_input_mismatch');
                requireThat(quote.offer.expiresAt > now(), 'quote_expired');
                // One provider offer represents one purchase, regardless of caller keys.
                requireThat(!(await tx.read('admitted-quotes', quoteId)), 'quote_already_admitted');
                const offerKey = digest({ provider: quote.offer.provider, id: quote.offer.id });
                requireThat(!(await tx.read('admitted-offers', offerKey)), 'provider_offer_already_admitted');
                if (quote.sponsored) {
                    const current = (await policies.active('review.sponsorship', tx)).config;
                    requireThat(current.enabled && current.capabilities.includes('review.code') &&
                        'sponsor:' + current.payer.toLowerCase() === quote.sponsorAccount, 'sponsorship_revoked');
                    (await reserve(tx, quote.sponsorAccount, quote.offer.asset, quote.maximum.sponsor));
                }
                (await reserve(tx, quote.projectAccount, quote.offer.asset, quote.maximum.project));
                const job = {
                    id, projectId, quoteId, inputHash, requestHash, work: 'queued', billing: 'reserved',
                    maximum: quote.maximum, policyRefs: quote.policyRefs
                };
                (await tx.write('review-jobs', id, job, 0));
                (await tx.write('admitted-quotes', quoteId, { jobId: id }, 0));
                (await tx.write('admitted-offers', offerKey, { jobId: id }, 0));
                (await tx.event({ type: 'review.admitted', jobId: id, projectId, maximum: quote.maximum, at: now() }));
                return copy(job);
            });
        },
        async job({ actor, projectId, jobId }) {
            (await authorize(check, actor, 'review.read', { projectId }));
            return (await find(store, 'review-jobs', jobId, projectId)).value;
        },
        async markUnknown({ actor, projectId, jobId }) {
            (await authorize(check, actor, 'review.report', { projectId }));
            return store.transaction(async (tx) => {
                await authorize(check, actor, 'review.report', { projectId }, tx);
                const old = (await find(tx, 'review-jobs', jobId, projectId));
                if (old.value.work === 'outcome_unknown')
                    return old.value;
                const value = { ...old.value, work: 'outcome_unknown' };
                if (value.billing === 'reserved')
                    value.billing = 'pending';
                (await tx.write('review-jobs', jobId, value, old.revision));
                (await tx.event({ type: 'review.outcome_unknown', jobId, projectId, at: now() }));
                return value;
            });
        },
        async recordCost({ actor, projectId, jobId, receipt }) {
            (await authorize(check, actor, 'review.settle', { projectId }));
            const evidence = copy(receipt);
            shape(evidence, ['id', 'provider', 'providerQuoteId', 'inputHash', 'asset', 'actual']);
            text(evidence.id);
            amount(evidence.actual);
            const job = (await find(store, 'review-jobs', jobId, projectId)).value;
            const quote = (await find(store, 'review-quotes', job.quoteId, projectId)).value;
            requireThat(evidence.provider === quote.offer.provider &&
                evidence.providerQuoteId === quote.offer.id && evidence.inputHash === quote.inputHash &&
                evidence.asset === quote.offer.asset, 'cost_receipt_mismatch');
            requireThat((await verifyCost(evidence, copy(quote.offer))) === true, 'cost_not_verified');
            requireThat(amount(evidence.actual) <= amount(quote.offer.maximum), 'cost_exceeds_reservation');
            const receiptKey = digest({ provider: evidence.provider, id: evidence.id });
            const receiptHash = digest({ jobId, evidence });
            return store.transaction(async (tx) => {
                await authorize(check, actor, 'review.settle', { projectId }, tx);
                const existing = (await tx.read('cost-receipts', receiptKey));
                if (existing) {
                    requireThat(existing.value.hash === receiptHash, 'cost_receipt_conflict');
                    return (await find(tx, 'review-jobs', jobId, projectId)).value;
                }
                const old = (await find(tx, 'review-jobs', jobId, projectId));
                requireThat(old.value.billing !== 'settled', 'job_already_settled');
                const actual = price({
                    providerAmount: evidence.actual, asset: quote.offer.asset,
                    fees: quote.feeTerms, sponsored: quote.sponsored
                });
                if (quote.sponsored) {
                    (await settleReservation(tx, quote.sponsorAccount, quote.offer.asset, quote.maximum.sponsor, actual.sponsor));
                }
                (await settleReservation(tx, quote.projectAccount, quote.offer.asset, quote.maximum.project, actual.project));
                const value = { ...old.value, billing: 'settled', actual, costReceiptId: evidence.id };
                (await tx.write('cost-receipts', receiptKey, { hash: receiptHash, jobId, receipt: evidence }, 0));
                (await tx.write('review-jobs', jobId, value, old.revision));
                (await tx.event({ type: 'review.cost_settled', jobId, projectId, actual, receiptId: evidence.id, at: now() }));
                return value;
            });
        }
    };
}
