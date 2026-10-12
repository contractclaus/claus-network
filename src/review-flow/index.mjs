import { digest, requireThat, text } from '../shared/index.mjs';

export function createReviewFlow({ store, identity, projects, builds, jobs, artifacts, reviews,
  workerActor, verifySource, now = () => Date.now() }) {
  async function getCase(reader, projectId, id) {
    const record = await reader.read('review-cases', text(id));
    requireThat(record?.value.projectId === projectId, 'not_found');
    return record;
  }
  async function sponsor(reader, projectId) {
    const value = (await reader.read('review-pilots', projectId))?.value;
    requireThat(value?.enabled === true && value.expiresAt > now(), 'sponsor_not_enabled');
    return value;
  }
  async function sourceIsPublished(reader, value) {
    const source = (await reader.read('public-sources', digest({ projectId: value.projectId, id: value.input.sourceHash })))?.value;
    requireThat(source?.published === true, 'source_not_published');
  }
  async function mayDispatch(reader, value, actor, action) {
    await identity.authorize(actor, action, { projectId: value.projectId }, reader);
    await sponsor(reader, value.projectId);
    await sourceIsPublished(reader, value);
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
    async pilot(actor, projectId) {
      await networkOwner(store, actor);
      const record = await store.read('review-pilots', text(projectId));
      return { projectId, ...(record?.value ?? { enabled: false }), revision: record?.revision ?? 0 };
    },
    async setPilot(actor, projectId, { enabled, expiresAt, maximumPerReview, expectedRevision }) {
      requireThat(typeof enabled === 'boolean' && Number.isSafeInteger(expiresAt) && expiresAt > now() &&
        expiresAt <= now() + 30 * 86400000 && typeof maximumPerReview === 'string' &&
        /^[1-9][0-9]{0,17}$/.test(maximumPerReview) && BigInt(maximumPerReview) <= 500000000000000000n &&
        Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, 'invalid_pilot');
      return store.transaction(async tx => {
        await networkOwner(tx, actor);
        requireThat(await tx.read('projects', text(projectId)), 'not_found');
        const value = { enabled, expiresAt, maximumPerReview };
        const record = await tx.write('review-pilots', projectId, value, expectedRevision);
        await tx.event({ type: 'review.pilot_changed', projectId, ...value, revision: record.revision, at: now() });
        return { projectId, ...value, revision: record.revision };
      });
    },
    async request(actor, projectId, { buildId, repoUrl, baseCommit, idempotencyKey }) {
      text(idempotencyKey);
      requireThat(/^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repoUrl) && /^[0-9a-f]{40}$/.test(baseCommit), 'unsupported_source_host');
      const build = await builds.get(actor, projectId, buildId);
      requireThat(build.state === 'compiled' && build.artifactHash, 'build_not_complete');
      const input = { repoUrl, baseCommit, contracts: [build.entry], sourceHash: build.snapshotId, buildHash: build.artifactHash };
      const inputHash = digest(input), id = digest({ projectId, review: idempotencyKey });
      return store.transaction(async tx => {
        const value = { id, projectId, buildId, input, inputHash, createdAt: now(), quoteId: null, reviewJobId: null, state: 'preparing' };
        await mayDispatch(tx, value, actor, 'review.quote');
        const old = await tx.read('review-cases', id);
        if (old) { requireThat(old.value.inputHash === inputHash, 'idempotency_conflict'); return old.value; }
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
      return { ...value, state: ['cancelled', 'failed', 'blocked'].includes(workflow?.state) ? workflow.state : value.state,
        workflow: workflow ? { state: workflow.state, result: workflow.result } : null, quote, job };
    },
    async artifact(actor, projectId, id) {
      await identity.authorize(actor, 'review.read', { projectId });
      const value = (await getCase(store, projectId, id)).value;
      requireThat(value.artifactHash, 'review_not_complete');
      return artifacts.get(projectId, value.artifactHash);
    },
    async publish(actor, projectId, { caseId, published, expectedRevision }) {
      requireThat(typeof published === 'boolean' && Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, 'invalid_publication');
      return store.transaction(async tx => {
        await identity.authorize(actor, 'project.publish', { projectId }, tx);
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
    async beforeAdmission(tx, { actor, projectId, quote }) {
      const value = (await getCase(tx, projectId, quote.id)).value;
      await mayDispatch(tx, value, actor, 'review.admit');
      requireThat(value.state === 'quoted' && value.inputHash === quote.inputHash, 'quote_input_mismatch');
      const pilot = await sponsor(tx, projectId);
      requireThat(BigInt(quote.offer.maximum) <= BigInt(pilot.maximumPerReview), 'sponsor_limit');
      const active = (await tx.read('active-paid-reviews', 'global'))?.value.ids ?? [];
      const live = [];
      for (const id of active) {
        const job = (await tx.read('review-jobs', id))?.value;
        if (job && !(['completed', 'cancelled', 'failed'].includes(job.work) && ['settled', 'void'].includes(job.billing))) live.push(job);
      }
      requireThat(live.length < 8 && !live.some(job => job.projectId === projectId), 'review_in_progress');
      for (const [subject, maximum] of [[projectId, 2], ['global', 8]]) {
        const key = digest({ subject, day: Math.floor(now() / 86400000), version: 'review-admission-v1' });
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
        const denied = ['scope_denied', 'source_not_published', 'sponsor_not_enabled'].includes(error.code);
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
          'payment_not_authorized', 'payment_window_expired', 'quote_expired'].includes(error.code);
        if (denied && payment.abandonUnsent) {
          try {
            return await jobs.finish(claim, { state: 'blocked', result: { error: error.code } }, async tx => {
              requireThat(await payment.abandonUnsent(tx, quote.offer.id), 'effect_requires_reconciliation');
              await reviews.cancelUnsent(tx, { actor: workerActor, projectId: value.projectId, jobId: value.reviewJobId });
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
