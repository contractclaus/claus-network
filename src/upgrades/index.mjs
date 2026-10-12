import { integer, shape } from '../shared/index.mjs';

export function validateUpgradeRules(value) {
  shape(value, ['minDelaySeconds', 'requiredReviews', 'maxFeeBps']);
  integer(value.minDelaySeconds, 0, 2592000);
  integer(value.requiredReviews, 0, 20);
  integer(value.maxFeeBps, 0, 10000);
}

// A policy calculation, not an onchain security mechanism or approval.
// acceptedTerms must come from the deployed contract's verified protection
// profile. A request must never choose its own acceptedTerms.
export function effectiveUpgradeRules(policy, acceptedTerms) {
  validateUpgradeRules(policy); validateUpgradeRules(acceptedTerms);
  return {
    minDelaySeconds: Math.max(policy.minDelaySeconds, acceptedTerms.minDelaySeconds),
    requiredReviews: Math.max(policy.requiredReviews, acceptedTerms.requiredReviews),
    maxFeeBps: Math.min(policy.maxFeeBps, acceptedTerms.maxFeeBps)
  };
}
