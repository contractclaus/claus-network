import { authorize, requireThat } from './shared/index.mjs';
import { openStore } from './storage/index.mjs';
import { createPolicies } from './policies/index.mjs';
import { createBilling, validateFees, validateSponsorship } from './billing/index.mjs';
import { createReviews } from './reviews/index.mjs';
import { validateUpgradeRules } from './upgrades/index.mjs';
export { effectiveUpgradeRules } from './upgrades/index.mjs';
// Composition root. Authentication, provider quotes and cost verification are
// trusted host ports, never values selected by a project or returned by a model.
export function createNetwork({ databasePath, store: suppliedStore, ownerAddress, authorize: check = () => false, provider = null, verifyCost = () => false, onReviewAdmission, beforeReviewAdmission, now = () => Date.now() }) {
    requireThat(typeof ownerAddress === 'string' && /^0x[0-9a-fA-F]{40}$/.test(ownerAddress), 'invalid_owner');
    const store = suppliedStore ?? openStore(databasePath);
    const dependencies = { store, authorize: check, now };
    const policies = createPolicies({
        ...dependencies,
        schemas: {
            'review.fees': validateFees,
            'review.sponsorship': validateSponsorship,
            'upgrade.rules': validateUpgradeRules
        }
    });
    const billing = createBilling(dependencies);
    const reviews = createReviews({ ...dependencies, policies, provider, verifyCost,
        onAdmission: onReviewAdmission, beforeAdmission: beforeReviewAdmission });
    return {
        policies, billing, reviews,
        async bootstrap({ actor }) {
            (await authorize(check, actor, 'network.bootstrap', { ownerAddress }));
            await store.transaction(async tx => {
                await authorize(check, actor, 'network.bootstrap', { ownerAddress }, tx);
                const authority = await tx.read('network', 'authority');
                requireThat(!authority || authority.value.ownerAddress === ownerAddress.toLowerCase(), 'owner_mismatch');
                if (!authority) await tx.write('network', 'authority', { ownerAddress: ownerAddress.toLowerCase() }, 0);
            });
            const baseline = {
                'review.fees': { rateBps: 0, flatByAsset: {} },
                'review.sponsorship': { enabled: true, payer: ownerAddress.toLowerCase(), capabilities: ['review.code'] }
            };
            for (const [module, config] of Object.entries(baseline)) {
                (await policies.publish({ actor, module, version: 'launch-v1', config }));
                try {
                    (await policies.active(module));
                }
                catch (error) {
                    if (error.code !== 'policy_not_active')
                        throw error;
                    try { await policies.activate({ actor, module, version: 'launch-v1', expectedGeneration: 0 }); }
                    catch (conflict) {
                        if (conflict.code !== 'revision_conflict') throw conflict;
                        await policies.active(module);
                    }
                }
            }
        },
        async history({ actor }) {
            (await authorize(check, actor, 'audit.read'));
            return (await store.events());
        },
        async close() { (await store.close()); }
    };
}
