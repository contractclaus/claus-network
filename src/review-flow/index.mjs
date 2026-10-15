import { NATIVE_PROGRAM_PROFILE } from './native-program.mjs';
import { createReviewAdmission } from './admission.mjs';
import { digest, requireThat, text } from '../shared/index.mjs';

export function createReviewFlow({ store, identity, projects, builds, jobs, artifacts, reviews,
  workerActor, verifySource, validatePublicBuild, selectReviewProfile, now = () => Date.now() }) {
  async function getCase(reader, projectId, id) {
    const record = await reader.read('review-cases', text(id));
    requireThat(record?.value.projectId === projectId, 'not_found');
    return record;
  }
  const admission = createReviewAdmission({ store, networkOwner, now });
  const sponsor = (reader, projectId) => admission.eligible(reader, projectId);
  async function sourceIsPublished(reader, value) {
    const source = (await reader.read('public-sources', digest({ projectId: value.projectId, id: value.input.sourceHash })))?.value;
    requireThat(source?.published === true, 'source_not_published');
  }
  async function mayDispatch(reader, value, actor, action) {
    await identity.authorize(actor, action, { projectId: value.projectId }, reader);
    await sponsor(reader, value.projectId);
    await sourceIsPublished(reader, value);
    if (value.profile === NATIVE_PROGRAM_PROFILE)
      await selectReviewProfile(reader, value.projectId, { actor, chainId: value.chainId, profile: value.profile });
    return true;
  }
  async function networkOwner(reader, actor) {
    const credential = await identity.credential(actor, reader);
    const principal = (await reader.read('principals', credential.principalId))?.value;
    const authority = (await reader.read('network', 'authority'))?.value;
    requireThat(credential.kind === 'owner' && principal?.chainId === 1 &&
      typeof principal?.address === 'string' && principal.address === authority?.ownerAddress, 'scope_denied');
  }
  const api = {
    admission,
    async pilot(actor, projectId) {
      await networkOwner(store, actor);
      const record = await store.read('review-pilots', text(projectId));
      return { projectId, ...(record?.value ?? { enabled: false }), revision: record?.revision ?? 0 };
    },
    async setPilot(actor, projectId, { enabled, expiresAt, maximumPerReview, expectedRevision, perProjectDay = 2, globalDay = 8 }) {
      requireThat(typeof enabled === 'boolean' && Number.isSafeInteger(expiresAt) && expiresAt > now() &&
        expiresAt <= now() + 30 * 86400000 && typeof maximumPerReview === 'string' &&
        /^[1-9][0-9]{0,17}$/.test(maximumPerReview) && BigInt(maximumPerReview) <= 500000000000000000n &&
        Number.isSafeInteger(expectedRevision) && expectedRevision >= 0 &&
        Number.isSafeInteger(perProjectDay) && perProjectDay >= 1 && perProjectDay <= 16 &&
        Number.isSafeInteger(globalDay) && globalDay >= 1 && globalDay <= 32, 'invalid_pilot');
      return store.transaction(async tx => {
        await networkOwner(tx, actor);
        requireThat(await tx.read('projects', text(projectId)), 'not_found');
        const value = { enabled, expiresAt, maximumPerReview, perProjectDay, globalDay };
        const record = await tx.write('review-pilots', projectId, value, expectedRevision);
        await tx.event({ type: 'review.pilot_changed', projectId, ...value, revision: record.revision, at: now() });
        return { projectId, ...value, revision: record.revision };
      });
    },
    async request(actor, projectId, { buildId, repoUrl, baseCommit, idempotencyKey, chainId, profile }) {
      text(idempotencyKey);
      requireThat(/^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repoUrl) && /^[0-9a-f]{40}$/.test(baseCommit), 'unsupported_source_host');
      const build = await builds.get(actor, projectId, buildId);
      requireThat(build.state === 'compiled' && build.artifactHash, 'build_not_complete');
      await identity.authorize(actor, 'review.quote', { projectId });
      const input = { repoUrl, baseCommit, contracts: [build.entry], sourceHash: build.snapshotId, buildHash: build.artifactHash,
        ...(profile === NATIVE_PROGRAM_PROFILE ? { reviewProfile: profile, chainId } : {}) };
      const inputHash = digest(input), id = digest({ projectId, review: idempotencyKey });
      return store.transaction(async tx => {
        const value = { id, projectId, buildId, input, inputHash, createdAt: now(), quoteId: null, reviewJobId: null, state: 'preparing' };
        await identity.authorize(actor, 'review.quote', { projectId }, tx);
        await sourceIsPublished(tx, value);
        const scope = selectReviewProfile ? await selectReviewProfile(tx, projectId, { chainId, profile, actor }) : null;
        requireThat(scope || chainId === undefined && profile === undefined, 'unsupported_profile');
        if (scope) { if (scope.chainId !== undefined) value.chainId = scope.chainId; value.profile = scope.profile; }
        const sameScope = record => (record.profile ?? 'claus-readonly-v1') === (scope?.profile ?? 'claus-readonly-v1') &&
          record.chainId === scope?.chainId;
        const old = await tx.read('review-cases', id);
        if (old) { requireThat(old.value.inputHash === inputHash && sameScope(old.value), 'idempotency_conflict'); return old.value; }
        const candidates = await tx.list('review-cases', { projectId, limit: 1000 });
        for (const row of candidates) {
          const prior = row.value;
          if (prior.inputHash !== inputHash) continue;
          const existing = () => { requireThat(sameScope(prior), 'review_scope_conflict'); return prior; };
          // A paid or uncertain attempt is never replaced by a new key.
          if (prior.state === 'reviewed') return existing();
          if (prior.state === 'admitted') {
            const job = prior.reviewJobId && (await tx.read('review-jobs', prior.reviewJobId))?.value;
            // Only the atomic, proven-unsent cancellation path releases this
            // source. Paid, unknown and missing records retain their identity.
            if (job?.work !== 'cancelled' || job.billing !== 'void') return existing();
          }
          const workflow = (await tx.read('workflow-jobs', prior.quoteJobId))?.value;
          if (prior.state === 'preparing' && workflow &&
            !['failed', 'blocked', 'cancelled'].includes(workflow.state)) return existing();
          const quote = prior.quoteId && (await tx.read('review-quotes', prior.quoteId))?.value;
          if (prior.state === 'quoted' && quote?.offer.expiresAt > now()) return existing();
        }
        requireThat(candidates.length < 64, 'capacity_reached');
        const eligibility = await sponsor(tx, projectId);
        if (eligibility.kind === 'public' || scope?.profile === 'claus-managed-v1' || scope?.profile === NATIVE_PROGRAM_PROFILE) {
          requireThat(typeof validatePublicBuild === 'function', 'unsupported_profile');
          await validatePublicBuild(await artifacts.get(projectId, build.artifactHash, tx), scope?.profile);
        }
        const active = await tx.read('active-review-case', projectId);
        if (active) {
          const prior = await tx.read('workflow-jobs', active.value.quoteJobId);
          requireThat(!prior || ['complete', 'failed', 'blocked', 'cancelled'].includes(prior.value.state), 'review_in_progress');
        }
        const job = await jobs.enqueue(tx, { projectId, kind: 'review-quote', payload: { caseId: id }, authority: { actor }, idempotencyKey: id });
        value.quoteJobId = job.id;
        await tx.write('review-cases', id, value, 0);
        const inputId = digest({ projectId, inputHash });
        if (!await tx.read('review-inputs', inputId)) await tx.write('review-inputs', inputId, { input }, 0);
        await tx.write('active-review-case', projectId, { quoteJobId: job.id }, active?.revision ?? 0);
        return value;
      });
    },
    async get(actor, projectId, id) {
      await identity.authorize(actor, 'review.read', { projectId });
      const value = (await getCase(store, projectId, id)).value;
      const quote = value.quoteId ? (await store.read('review-quotes', value.quoteId))?.value : null;
      const job = value.reviewJobId ? await reviews.job({ actor, projectId, jobId: value.reviewJobId }) : null;
      const workflow = (await store.read('workflow-jobs', value.executionJobId ?? value.quoteJobId))?.value;
      const publication = await store.read('review-publications', id);
      return { ...value, state: ['cancelled', 'failed', 'blocked'].includes(workflow?.state) ? workflow.state : value.state,
        publication: { published: publication?.value.published === true, revision: publication?.revision ?? 0 },
        workflow: workflow ? { state: workflow.state, result: workflow.result } : null, quote, job };
    },
    async artifact(actor, projectId, id) {
      await identity.authorize(actor, 'review.read', { projectId });
      const value = (await getCase(store, projectId, id)).value;
      requireThat(value.artifactHash, 'review_not_complete');
      return artifacts.get(projectId, value.artifactHash);
    },
    async publicReport(caseId) {
      const value = (await store.read('review-cases', text(caseId)))?.value;
      requireThat(value?.state === 'reviewed' && value.artifactHash && value.providerJobId, 'not_found');
      const project = (await store.read('projects', value.projectId))?.value;
      const publication = (await store.read('review-publications', caseId))?.value;
      const profile = project && (await store.read('public-projects', project.slug))?.value;
      const source = (await store.read('public-sources', digest({ projectId: value.projectId, id: value.input.sourceHash })))?.value;
      const evidence = (await store.read('public-evidence', value.projectId))?.value;
      requireThat(project && !project.archivedAt && publication?.published === true && profile?.published === true &&
        profile.projectId === value.projectId && source?.published === true &&
        evidence?.reviews.some(item => item.id === caseId && item.artifactHash === value.artifactHash), 'not_found');
      const artifact = await artifacts.get(value.projectId, value.artifactHash);
      requireThat(artifact.complete === true && artifact.jobId === value.providerJobId &&
        typeof artifact.report === 'string' && Buffer.byteLength(artifact.report) <= 1048576, 'review_report_invalid');
      return { caseId, projectId: value.projectId, artifactHash: value.artifactHash,
        provider: 'imd-audit-v1', providerJobId: value.providerJobId, report: artifact.report,
        reportHash: digest(artifact.report), sourceKind: artifact.reportSource?.kind === 'accepted-audit-submission'
          ? 'accepted-audit-submission' : 'provider-markdown' };
    },
    async publish(actor, projectId, { caseId, published, expectedRevision }) {
      requireThat(typeof published === 'boolean' && Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, 'invalid_publication');
      return store.transaction(async tx => {
        await identity.authorize(actor, 'project.publish', { projectId, withdrawal: !published }, tx);
        const value = (await getCase(tx, projectId, caseId)).value;
        requireThat(value.state === 'reviewed' && value.artifactHash && value.providerJobId, 'review_not_complete');
        const old = await tx.read('review-publications', caseId);
        requireThat((old?.revision ?? 0) === expectedRevision, 'revision_conflict');
        const evidence = await tx.read('public-evidence', projectId);
        const prior = evidence?.value ?? { reviews: [], decisions: [], deployments: [] };
        const entries = prior.reviews.filter(item => item.id !== caseId);
        if (published) {
          await sourceIsPublished(tx, value);
          requireThat(entries.length < 50, 'capacity_reached');
          entries.push({ id: caseId, providerJobId: value.providerJobId, status: 'Reviewed',
            sourceHash: value.input.sourceHash, buildHash: value.input.buildHash, artifactHash: value.artifactHash,
            repository: value.input.repoUrl, commit: value.input.baseCommit });
        }
        await tx.write('public-evidence', projectId, { ...prior, reviews: entries }, evidence?.revision ?? 0);
        const saved = await tx.write('review-publications', caseId, { published }, expectedRevision);
        await tx.event({ type: published ? 'review.published' : 'review.withdrawn', projectId, caseId, at: now() });
        return { caseId, published, revision: saved.revision };
      });
    },
    async accept(actor, projectId, { caseId, quoteId, idempotencyKey }) {
      const value = (await getCase(store, projectId, caseId)).value;
      requireThat(value.quoteId === quoteId && ['quoted', 'admitted', 'reviewed'].includes(value.state), 'quote_not_ready');
      return reviews.admit({ actor, projectId, quoteId, inputHash: value.inputHash, idempotencyKey });
    },
    async beforeAdmission(tx, { actor, projectId, quote, jobId }) {
      const value = (await getCase(tx, projectId, quote.id)).value;
      await mayDispatch(tx, value, actor, 'review.admit');
      requireThat(value.state === 'quoted' && value.inputHash === quote.inputHash, 'quote_input_mismatch');
      const pilot = await sponsor(tx, projectId);
      requireThat(BigInt(quote.offer.maximum) <= BigInt(pilot.maximumPerReview), 'sponsor_limit');
      if (pilot.kind === 'public' || value.profile === NATIVE_PROGRAM_PROFILE) {
        requireThat(typeof validatePublicBuild === 'function', 'unsupported_profile');
        if (selectReviewProfile && value.profile)
          await selectReviewProfile(tx, projectId, { chainId: value.chainId, profile: value.profile, actor });
        await validatePublicBuild(await artifacts.get(projectId, value.input.buildHash, tx), value.profile);
        if (pilot.kind === 'public') await admission.reserve(tx, projectId, quote.offer.maximum, pilot, jobId);
      }
      const active = (await tx.read('active-paid-reviews', 'global'))?.value.ids ?? [];
      const live = [];
      for (const id of active) {
        const job = (await tx.read('review-jobs', id))?.value;
        if (job && !(['completed', 'cancelled', 'failed'].includes(job.work) && ['settled', 'void'].includes(job.billing))) live.push(job);
      }
      requireThat(live.length < (pilot.kind === 'public' ? pilot.activeGlobal : 8) && !live.some(job => job.projectId === projectId), 'review_in_progress');
      for (const [subject, maximum] of [[projectId, pilot.perProjectDay ?? 2], ['global', pilot.globalDay ?? 8]]) {
        // Public sponsorship has its own finite allocation. Keep the original
        // pilot counters intact; a new public pool does not reset or consume it.
        const key = digest({ subject, day: Math.floor(now() / 86400000),
          version: pilot.kind === 'public' ? 'public-review-admission-v1' : 'review-admission-v1' });
        const old = await tx.read('review-admission', key);
        requireThat((old?.value.count ?? 0) < maximum, 'capacity_reached');
        await tx.write('review-admission', key, { count: (old?.value.count ?? 0) + 1 }, old?.revision ?? 0);
      }
    },
    async onAdmission(tx, { actor, projectId, quote, job }) {
      const old = await getCase(tx, projectId, quote.id);
      const active = await tx.read('active-paid-reviews', 'global');
      const ids = [];
      for (const id of active?.value.ids ?? []) {
        const current = (await tx.read('review-jobs', id))?.value;
        if (current && !(['completed', 'cancelled', 'failed'].includes(current.work) && ['settled', 'void'].includes(current.billing))) ids.push(id);
      }
      await tx.write('active-paid-reviews', 'global', { ids: [...ids, job.id] }, active?.revision ?? 0);
      const workflow = await jobs.enqueue(tx, { projectId, kind: 'review-execute', payload: { caseId: quote.id, reviewJobId: job.id },
        authority: { actor }, idempotencyKey: job.id });
      await tx.write('review-cases', quote.id, { ...old.value, state: 'admitted', reviewJobId: job.id, executionJobId: workflow.id }, old.revision);
    },
    async onCancel(tx, job) {
      if (job.kind !== 'review-execute') return;
      await reviews.cancelUnsent(tx, { actor: workerActor, projectId: job.projectId, jobId: job.payload.reviewJobId });
      await admission.releaseUnsent(tx, job.payload.reviewJobId);
    },
    async resolveInput(projectId, inputHash) {
      const input = (await store.read('review-inputs', digest({ projectId, inputHash })))?.value.input;
      requireThat(input && digest(input) === inputHash, 'review_input_missing');
      return input;
    },
    async paymentAuthority(claim, { offerId, amount }, reader) {
      const current = await jobs.assertCurrent(claim, reader);
      const value = (await getCase(reader, current.projectId, current.payload.caseId)).value;
      await mayDispatch(reader, value, current.authority.actor, 'review.admit');
      const job = (await reader.read('review-jobs', value.reviewJobId))?.value;
      const quote = (await reader.read('review-quotes', value.quoteId))?.value;
      return !!job && ['reserved', 'pending'].includes(job.billing) && quote.offer.id === offerId && quote.offer.maximum === amount;
    },
    async runQuote() {
      requireThat(typeof verifySource === 'function', 'worker_not_configured');
      const claim = await jobs.claim({ kinds: ['review-quote'], leaseMs: 120000 });
      if (claim.idle) return claim;
      const value = (await getCase(store, claim.job.projectId, claim.job.payload.caseId)).value;
      const actor = claim.job.authority.actor;
      try {
        await mayDispatch(store, value, actor, 'review.quote');
        const files = await projects.files(actor, value.projectId, value.input.sourceHash);
        const binding = await verifySource({ input: value.input, files });
        requireThat(binding.inputHash === value.inputHash, 'source_mismatch');
        await jobs.assertCurrent(claim);
        const quote = await reviews.quote({ actor, id: value.id, projectId: value.projectId, inputHash: value.inputHash });
        return jobs.finish(claim, { state: 'complete', result: { quoteId: quote.id } }, async tx => {
          await mayDispatch(tx, value, actor, 'review.quote');
          const old = await getCase(tx, value.projectId, value.id);
          await tx.write('review-cases', value.id, { ...old.value, state: 'quoted', quoteId: quote.id, sourceBinding: binding }, old.revision);
        });
      } catch (error) {
        if (error.code === 'lease_lost') return { stale: true };
        const denied = ['scope_denied', 'source_not_published', 'sponsor_not_enabled', 'native_program_review_not_enabled'].includes(error.code);
        const retry = !denied && ['provider_outcome_unknown', 'source_unavailable'].includes(error.code) && claim.job.attempts < 3;
        const state = retry ? 'waiting' : denied ? 'blocked' : 'failed';
        return jobs.finish(claim, { state, result: { error: error.code ?? 'review_quote_failed' }, retryAt: retry ? now() + 60000 : null });
      }
    },
    async runPaid({ createPayment, provider, costReceipt }) {
      const claim = await jobs.claim({ kinds: ['review-execute'], leaseMs: 300000 });
      if (claim.idle) return claim;
      const value = (await getCase(store, claim.job.projectId, claim.job.payload.caseId)).value;
      const quote = (await store.read('review-quotes', value.quoteId)).value;
      const payment = createPayment(claim);
      try {
        let state = await payment.status(quote.offer.id);
        // No material left the signing host in these states. Close a failed
        // local attempt using the same fenced abandonment path after restart.
        if (state && ['signing', 'signing_unknown', 'cancelled'].includes(state.state))
          throw Object.assign(Error('payment_signing_unknown'), { code: 'payment_signing_unknown' });
        if (!state) {
          if (claim.mode === 'dispatch') await jobs.beginEffect(claim, (_job, tx) => mayDispatch(tx, value, claim.job.authority.actor, 'review.admit'));
          await mayDispatch(store, value, claim.job.authority.actor, 'review.admit');
          await reviews.markUnknown({ actor: workerActor, projectId: value.projectId, jobId: value.reviewJobId });
          state = await payment.prepare(quote.offer.id);
        }
        if (state.state === 'prepared') await payment.submit(quote.offer.id);
        state = await payment.reconcile(quote.offer.id);
        const cost = await costReceipt({ state, offer: quote.offer, inputHash: value.inputHash });
        if (cost) await reviews.recordCost({ actor: workerActor, projectId: value.projectId, jobId: value.reviewJobId, receipt: cost });
        const providerJobId = state.outcome?.admission?.result?.jobId;
        if (providerJobId) {
          const report = await provider.report(providerJobId);
          if (['failed', 'cancelled', 'expired'].includes(report.state) &&
              (await store.read('review-jobs', value.reviewJobId)).value.billing === 'settled') {
            await reviews.failure({ actor: workerActor, projectId: value.projectId, jobId: value.reviewJobId,
              providerJobId, reason: 'provider_' + report.state });
            return jobs.finish(claim, { state: 'failed', result: { providerJobId, error: 'provider_' + report.state } });
          }
          if (report.complete) {
            requireThat(report.submissions?.repoUrl === value.input.repoUrl && report.submissions?.baseCommit === value.input.baseCommit, 'review_source_mismatch');
            requireThat(report.submissions.submissions.every(s => !s.accepted || s.baseCommit === value.input.baseCommit), 'review_source_mismatch');
            const artifactHash = await store.transaction(tx => artifacts.put(tx, value.projectId, report));
            await reviews.result({ actor: workerActor, projectId: value.projectId, jobId: value.reviewJobId, artifactHash, providerJobId });
            if ((await store.read('review-jobs', value.reviewJobId)).value.billing !== 'settled') {
              return jobs.finish(claim, { state: 'waiting', retryAt: now() + 60000, result: { artifactHash, providerJobId, billing: 'pending' } });
            }
            return jobs.finish(claim, { state: 'complete', result: { artifactHash, providerJobId } }, async tx => {
              const old = await getCase(tx, value.projectId, value.id);
              await tx.write('review-cases', value.id, { ...old.value, state: 'reviewed', artifactHash, providerJobId }, old.revision);
            });
          }
        }
        return jobs.finish(claim, { state: 'waiting', retryAt: now() + 60000, result: { providerJobId: providerJobId ?? null, paymentState: state.state } });
      } catch (error) {
        if (error.code === 'lease_lost') return { stale: true };
        const denied = ['scope_denied', 'unauthenticated', 'source_not_published', 'sponsor_not_enabled',
          'native_program_review_not_enabled', 'payment_not_authorized', 'payment_window_expired', 'payment_signing_unknown', 'quote_expired'].includes(error.code);
        if (denied && payment.abandonUnsent) {
          try {
            return await jobs.finish(claim, { state: 'blocked', result: { error: error.code } }, async tx => {
              requireThat(await payment.abandonUnsent(tx, quote.offer.id), 'effect_requires_reconciliation');
              await reviews.cancelUnsent(tx, { actor: workerActor, projectId: value.projectId, jobId: value.reviewJobId });
              await admission.releaseUnsent(tx, value.reviewJobId);
            });
          } catch (recoveryError) {
            if (recoveryError.code === 'lease_lost') return { stale: true };
            if (recoveryError.code !== 'effect_requires_reconciliation') throw recoveryError;
          }
        }
        if (error.code === 'review_source_mismatch' &&
            (await store.read('review-jobs', value.reviewJobId)).value.billing === 'settled') {
          await reviews.failure({ actor: workerActor, projectId: value.projectId, jobId: value.reviewJobId, reason: error.code });
          return jobs.finish(claim, { state: 'failed', result: { error: error.code } });
        }
        // Never erase a paid/unknown effect or infer a refund from failure.
        return jobs.finish(claim, { state: 'waiting', retryAt: now() + 120000, result: { error: error.code ?? 'review_reconciliation_required' } });
      }
    }
  };
  return api;
}
