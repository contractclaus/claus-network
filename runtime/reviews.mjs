import { createNetwork } from '../src/index.mjs';
import { createReviewFlow } from '../src/review-flow/index.mjs';

export function createReviewSystem({ store, identity, projects, builds, jobs, artifacts,
  ownerAddress = '0xBb145cA83272c3806D4dDc75cA1D5514789cF1C5', provider = null,
  verifyCost = async () => false, verifySource, validatePublicBuild, selectReviewProfile, now = () => Date.now() }) {
  // API actors are credential digests. This host-only actor is never returned
  // by authentication or accepted as a bearer credential.
  const workerActor = 'worker:review';
  const internalActions = new Set(['network.bootstrap', 'policy.publish', 'policy.activate', 'funding.record',
    'billing.read', 'audit.read', 'review.report', 'review.read', 'review.settle', 'review.cancel_unsent']);
  let flow;
  const network = createNetwork({ store, ownerAddress, now, provider, verifyCost,
    authorize: (actor, action, scope, reader) => actor === workerActor ? internalActions.has(action) : identity.allowed(actor, action, scope, reader),
    beforeReviewAdmission: (tx, input) => flow.beforeAdmission(tx, input),
    onReviewAdmission: (tx, input) => flow.onAdmission(tx, input) });
  flow = createReviewFlow({ store, identity, projects, builds, jobs, artifacts, reviews: network.reviews, workerActor, verifySource, validatePublicBuild, selectReviewProfile, now });
  return { flow, network, workerActor };
}
