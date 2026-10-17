import { operatingExpiry, operatingWindowOpen, amount, digest, integer, requireThat, shape } from '../shared/index.mjs';
import { operatingProject } from '../operating-access/index.mjs';
import { createPolicies } from '../policies/index.mjs';

// Public sponsorship is distinct from free project access and from chain admission.
export function createReviewAdmission({ store, networkOwner, now }) {
  const policies = createPolicies({ store, now,
    authorize: async (actor, _action, _scope, reader) => { await networkOwner(reader ?? store, actor); return true; },
    schemas: { 'review.admission': config => {
      shape(config, ['enabled', 'expiresAt', 'maximumPerReview', 'maximumLifetime', 'perOwnerDay', 'perProjectDay', 'globalDay', 'activeGlobal']);
      requireThat(typeof config.enabled === 'boolean', 'invalid_sponsorship');
      operatingExpiry(config.expiresAt);
      requireThat(amount(config.maximumPerReview) > 0n && amount(config.maximumPerReview) <= 500000000000000000n, 'sponsor_limit');
      requireThat(amount(config.maximumLifetime) >= amount(config.maximumPerReview), 'sponsor_limit');
      integer(config.perOwnerDay, 1, 2); integer(config.perProjectDay, 1, 2);
      integer(config.globalDay, 1, 8); integer(config.activeGlobal, 1, 8);
    } }
  });
  async function active(reader = store) {
    if (!await reader.read('policy-active', 'review.admission')) return null;
    return policies.active('review.admission', reader);
  }
  return {
    active,
    async eligible(reader, projectId) {
      const pilot = (await reader.read('review-pilots', projectId))?.value;
      if (pilot?.enabled && pilot.expiresAt > now()) return { ...pilot, kind: await operatingProject(reader, projectId) ? 'operating' : 'pilot', activeGlobal: 8 };
      const policy = await active(reader);
      requireThat(policy?.config.enabled && operatingWindowOpen(policy.config.expiresAt, now()), 'sponsor_not_enabled');
      return { ...policy.config, kind: await operatingProject(reader, projectId) ? 'operating' : 'public', generation: policy.generation };
    },
    async get(actor) {
      await networkOwner(store, actor);
      return { policy: await active(), committedMaximum: (await store.read('public-review-exposure', 'lifetime'))?.value.maximum ?? '0' };
    },
    async publish(actor, { version, config }) {
      requireThat(config.expiresAt === null || config.expiresAt <= now() + 30 * 86400000, 'invalid_sponsorship');
      return policies.publish({ actor, module: 'review.admission', version, config });
    },
    async activate(actor, { version, expectedGeneration }) {
      // Activation is configuration, not funding. The existing billing ledger
      // must still atomically reserve real available funds for every review.
      return policies.activate({ actor, module: 'review.admission', version, expectedGeneration });
    },
    async reserve(tx, projectId, maximum, config, jobId) {
      requireThat(typeof jobId === 'string' && !await tx.read('public-review-reservations', jobId), 'idempotency_conflict');
      const project = (await tx.read('projects', projectId)).value;
      const operating = config.kind === 'operating' && await operatingProject(tx, projectId);
      const exposureCollection = operating ? 'operating-review-exposure' : 'public-review-exposure';
      const ownerCollection = operating ? 'operating-review-owner-admission' : 'public-review-owner-admission';
      const ownerKey = digest({ ownerId: project.ownerId, day: Math.floor(now() / 86400000) });
      const ownerUsage = await tx.read(ownerCollection, ownerKey);
      requireThat(operating || (ownerUsage?.value.count ?? 0) < config.perOwnerDay, 'capacity_reached');
      const lifetime = await tx.read(exposureCollection, 'lifetime');
      const total = amount(lifetime?.value.maximum ?? '0') + amount(maximum);
      requireThat(operating || total <= amount(config.maximumLifetime), 'sponsor_exhausted');
      await tx.write(ownerCollection, ownerKey, { count: (ownerUsage?.value.count ?? 0) + 1 }, ownerUsage?.revision ?? 0);
      await tx.write(exposureCollection, 'lifetime', { maximum: total.toString() }, lifetime?.revision ?? 0);
      await tx.write('public-review-reservations', jobId, { projectId, maximum, released: false, exposureCollection }, 0);
    },
    async releaseUnsent(tx, jobId) {
      const row = await tx.read('public-review-reservations', jobId);
      if (!row || row.value.released) return;
      const job = (await tx.read('review-jobs', jobId))?.value;
      requireThat(job?.work === 'cancelled' && job.billing === 'void', 'effect_requires_reconciliation');
      const exposureCollection = row.value.exposureCollection ?? 'public-review-exposure';
      requireThat(['public-review-exposure', 'operating-review-exposure'].includes(exposureCollection), 'invalid_reservation');
      const lifetime = await tx.read(exposureCollection, 'lifetime');
      requireThat(amount(lifetime.value.maximum) >= amount(row.value.maximum), 'sponsor_exposure_mismatch');
      await tx.write(exposureCollection, 'lifetime', {
        maximum: (amount(lifetime.value.maximum) - amount(row.value.maximum)).toString()
      }, lifetime.revision);
      await tx.write('public-review-reservations', jobId, { ...row.value, released: true }, row.revision);
      // Daily counters measure attempts and remain consumed, preventing a
      // cancel/re-submit loop from bypassing admission throttles.
    }
  };
}
