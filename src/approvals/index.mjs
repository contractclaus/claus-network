import { canonical, digest, requireThat, text } from '../shared/index.mjs';

export function createApprovals({ store, identity, projects, reviews, deployments, jobs, artifacts, chain, now = () => Date.now() }) {
  function executionEvidence(value) {
    return { id: value.id, ...value.execution,
      verification: value.execution.verification.state === 'verified' ? 'verified' : 'pending',
      sourceVerification: value.execution.verification };
  }
  async function find(reader, projectId, id) {
    const row = await reader.read('chain-proposals', text(id));
    requireThat(row?.value.projectId === projectId, 'not_found'); return row;
  }
  async function allowed(actor, projectId, reader = store) {
    await identity.authorize(actor, 'proposal.create', { projectId }, reader);
    return deployments.allowed(actor, projectId, reader);
  }
  async function readInput(value, reader = store) { return artifacts.get(value.projectId, value.inputArtifactHash, reader); }
  async function consumerMatches(value, reader) {
    const vault = (await reader.read('project-vaults', value.projectId))?.value;
    const consumer = (await readInput(value, reader)).evidence.chain.consumer;
    requireThat(!vault && !consumer || vault?.state === 'verified' && consumer &&
      consumer.vault.address.toLowerCase() === vault.address.toLowerCase() && consumer.vault.codeHash === vault.codeHash &&
      consumer.policy.toLowerCase() === value.proposal.target.toLowerCase() && consumer.buildHash === vault.artifactHash &&
      consumer.review.artifactHash === vault.reviewArtifactHash, 'vault_review_context_changed');
  }
  const api = {
    async onCancel(tx, job) {
      if (!['claus-review', 'protected-execute'].includes(job.kind)) return;
      const old = await find(tx, job.projectId, job.payload.proposalId);
      await tx.write('chain-proposals', old.value.id, { ...old.value, state: 'cancelled', updatedAt: now() }, old.revision);
    },
    async create(actor, projectId, { moduleId, configuration, dependencies = [], idempotencyKey }) {
      text(idempotencyKey);
      const id = digest({ projectId, idempotencyKey, kind: 'protected-upgrade' });
      const requestHash = digest(dependencies.length ? { moduleId, configuration, dependencies } : { moduleId, configuration });
      await allowed(actor, projectId);
      const existing = await store.read('chain-proposals', id);
      if (existing) { requireThat(existing.value.requestHash === requestHash, 'idempotency_conflict'); return existing.value; }
      const module = await deployments.module(actor, projectId, moduleId);
      requireThat(module.state === 'verified', 'module_not_verified');
      const binding = await deployments.binding(actor, projectId);
      requireThat(binding, 'project_not_registered');
      const reviewed = await reviews.get(actor, projectId, module.caseId);
      requireThat(reviewed.state === 'reviewed' && reviewed.artifactHash, 'review_not_complete');
      const report = await reviews.artifact(actor, projectId, module.caseId);
      requireThat(report.complete === true && report.jobId === reviewed.providerJobId, 'review_mismatch');
      const files = (await projects.files(actor, projectId, reviewed.input.sourceHash)).map(({ path, content }) => ({ path, content }));
      const build = await artifacts.get(projectId, reviewed.input.buildHash);
      const vault = (await store.read('project-vaults', projectId))?.value;
      requireThat(!vault || vault.state === 'verified' && vault.artifactProjectId === projectId,
        'vault_review_context_changed');
      const consumer = vault ? { vault, build: await artifacts.get(projectId, vault.artifactHash),
        review: await artifacts.get(projectId, vault.reviewArtifactHash) } : undefined;
      const snapshot = await chain.captureEvidence({ module, dependencies, consumer });
      const source = { snapshotHash: reviewed.input.sourceHash, buildHash: reviewed.input.buildHash,
        repository: reviewed.input.repoUrl, commit: reviewed.input.baseCommit, entry: reviewed.input.contracts[0], files };
      chain.validateBuildEvidence(build, source, snapshot.implementation);
      const proposal = await chain.proposal({ binding, module, configuration, dependencySnapshot: snapshot,
        nonceSeed: id, now: Math.floor(now() / 1000) });
      const input = { projectId, caseId: module.caseId, proposal, proposalHash: digest(proposal),
        source, evidence: { build, chain: snapshot },
        review: { provider: 'imd-audit-v1', jobId: report.jobId, artifactHash: reviewed.artifactHash,
          report: report.report, repository: reviewed.input.repoUrl, commit: reviewed.input.baseCommit } };
      requireThat(Buffer.byteLength(canonical(input)) <= 900000, 'review_context_too_large');
      return store.transaction(async tx => {
        await allowed(actor, projectId, tx);
        requireThat(digest((await tx.read('project-vaults', projectId))?.value ?? null) === digest(vault ?? null),
          'vault_review_context_changed');
        const old = await tx.read('chain-proposals', id);
        if (old) { requireThat(old.value.requestHash === requestHash, 'idempotency_conflict'); return old.value; }
        const active = await tx.read('active-proposals', projectId);
        if (active) {
          const prior = (await tx.read('chain-proposals', active.value.id))?.value;
          requireThat(!prior || ['executed', 'rejected', 'failed', 'blocked', 'cancelled'].includes(prior.state), 'proposal_in_progress');
        }
        const inputArtifactHash = await artifacts.put(tx, projectId, input);
        const job = await jobs.enqueue(tx, { projectId, kind: 'claus-review', payload: { proposalId: id },
          authority: { actor }, idempotencyKey: id });
        const value = { id, projectId, requestHash, moduleId, caseId: module.caseId, proposal,
          proposalHash: input.proposalHash, reviewArtifactHash: reviewed.artifactHash, inputArtifactHash,
          state: 'reviewing', decisionJobId: job.id, createdAt: now() };
        await tx.write('chain-proposals', id, value, 0);
        await tx.write('active-proposals', projectId, { id }, active?.revision ?? 0);
        return value;
      });
    },
    async get(actor, projectId, id) {
      await identity.authorize(actor, 'proposal.read', { projectId });
      return (await find(store, projectId, id)).value;
    },
    async publish(actor, projectId, { proposalId, published, expectedRevision }) {
      requireThat(typeof published === 'boolean' && Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, 'invalid_publication');
      return store.transaction(async tx => {
        await identity.authorize(actor, 'project.publish', { projectId, withdrawal: !published }, tx);
        const value = (await find(tx, projectId, proposalId)).value;
        requireThat(value.decision, 'decision_not_complete');
        const publication = await tx.read('proposal-publications', proposalId);
        requireThat((publication?.revision ?? 0) === expectedRevision, 'revision_conflict');
        const evidence = await tx.read('public-evidence', projectId);
        const prior = evidence?.value ?? { reviews: [], decisions: [], deployments: [] };
        const decisions = prior.decisions.filter(x => x.id !== proposalId);
        const deployments = prior.deployments.filter(x => x.id !== proposalId);
        if (published) {
          const input = await readInput(value, tx);
          const source = await tx.read('public-sources', digest({ projectId, id: input.source.snapshotHash }));
          requireThat(source?.value.published === true, 'source_not_published');
          requireThat(decisions.length < 50 && deployments.length < 50, 'capacity_reached');
          const { decision, reason, risks, decisionHash, configurationRevision, model, completedAt } = value.decision;
          decisions.push({ id: proposalId, proposalHash: value.proposalHash,
            status: decision === 'approve' ? 'Approved' : 'Rejected', decision, reason, risks,
            decisionHash, configurationRevision, model, completedAt });
          if (value.state === 'executed') deployments.push(executionEvidence(value));
        }
        await tx.write('public-evidence', projectId, { ...prior, decisions, deployments }, evidence?.revision ?? 0);
        const saved = await tx.write('proposal-publications', proposalId, { published }, expectedRevision);
        await tx.event({ type: published ? 'proposal.published' : 'proposal.withdrawn', projectId, proposalId, at: now() });
        return { proposalId, published, revision: saved.revision };
      });
    },
    async runDecision(controller) {
      const claim = await jobs.claim({ kinds: ['claus-review'], leaseMs: 120000 });
      if (claim.idle) return claim;
      const value = (await find(store, claim.job.projectId, claim.job.payload.proposalId)).value;
      const authorize = async reader => {
        await jobs.assertCurrent(claim, reader); await allowed(claim.job.authority.actor, value.projectId, reader);
        await consumerMatches(value, reader);
        const reviewed = (await reader.read('review-cases', value.caseId))?.value;
        requireThat(reviewed?.state === 'reviewed' && reviewed.artifactHash === value.reviewArtifactHash, 'review_mismatch');
        const source = await reader.read('public-sources', digest({ projectId: value.projectId, id: reviewed.input.sourceHash }));
        requireThat(source?.value.published === true, 'source_not_published'); return true;
      };
      try {
        if (claim.mode === 'dispatch') await jobs.beginEffect(claim, (_job, tx) => authorize(tx));
        const result = await controller.step({ value, input: await readInput(value), authorize });
        const done = ['approved', 'rejected', 'failed', 'blocked'].includes(result.state);
        return jobs.finish(claim, { state: done ? result.state === 'blocked' ? 'blocked' : result.state === 'failed' ? 'failed' : 'complete' : 'waiting',
          retryAt: done ? null : now() + 30000, result: { state: result.state } }, async tx => {
          const old = await find(tx, value.projectId, value.id);
          const next = { ...old.value, ...result, updatedAt: now() };
          if (result.state === 'approved') {
            await authorize(tx);
            const execute = await jobs.enqueue(tx, { projectId: value.projectId, kind: 'protected-execute',
              payload: { proposalId: value.id }, authority: claim.job.authority, idempotencyKey: value.id });
            next.executionJobId = execute.id;
          }
          await tx.write('chain-proposals', value.id, next, old.revision);
        });
      } catch (error) {
        if (error.code === 'lease_lost') return { stale: true };
        const blocked = ['scope_denied', 'sponsor_not_enabled', 'chain_not_enabled', 'source_not_published', 'proposal_expiring', 'proposal_stale', 'project_suspended',
          'vault_review_context_changed', 'dependency_evidence_mismatch', 'evidence_block_changed', 'dependency_code_changed', 'dependency_code_missing',
          'dependency_delegation_unsupported', 'dependency_indirection_unsupported', 'dependency_proxy_unsupported'].includes(error.code);
        return jobs.finish(claim, { state: blocked ? 'blocked' : 'waiting', retryAt: blocked ? null : now() + 60000,
          result: { error: error.code ?? 'decision_unavailable' } }, async tx => {
          if (blocked) {
            const old = await find(tx, value.projectId, value.id);
            await tx.write('chain-proposals', value.id, { ...old.value, state: 'blocked', error: error.code }, old.revision);
          }
        });
      }
    },
    async runExecution(executor) {
      const claim = await jobs.claim({ kinds: ['protected-execute'], leaseMs: 120000 });
      if (claim.idle) return claim;
      const value = (await find(store, claim.job.projectId, claim.job.payload.proposalId)).value;
      const authorize = async reader => {
        await jobs.assertCurrent(claim, reader); await deployments.allowed(claim.job.authority.actor, value.projectId, reader);
        await consumerMatches(value, reader); return true;
      };
      try {
        if (claim.mode === 'dispatch') await jobs.beginEffect(claim, (_job, tx) => authorize(tx));
        const result = await executor.step({ value, authorize });
        const done = ['executed', 'failed', 'blocked'].includes(result.state);
        return jobs.finish(claim, { state: done ? result.state === 'executed' ? 'complete' : result.state : 'waiting',
          retryAt: done ? null : Math.max(now() + 30000, result.readyAt ? result.readyAt * 1000 : 0), result: { state: result.state } }, async tx => {
          const old = await find(tx, value.projectId, value.id);
          const next = { ...old.value, ...result, updatedAt: now() };
          await tx.write('chain-proposals', value.id, next, old.revision);
          if (next.state === 'executed') {
            const publication = await tx.read('proposal-publications', value.id);
            const evidence = await tx.read('public-evidence', value.projectId);
            if (publication?.value.published === true && evidence?.value.decisions.some(x => x.id === value.id)) {
              await tx.write('public-evidence', value.projectId, { ...evidence.value,
                deployments: [...evidence.value.deployments.filter(x => x.id !== value.id), executionEvidence(next)] }, evidence.revision);
            }
          }
        });
      } catch (error) {
        if (error.code === 'lease_lost') return { stale: true };
        if (claim.mode === 'dispatch' && ['scope_denied', 'sponsor_not_enabled', 'chain_not_enabled', 'vault_review_context_changed'].includes(error.code)) {
          return jobs.finish(claim, { state: 'blocked', result: { error: error.code } }, async tx => {
            const old = await find(tx, value.projectId, value.id);
            await tx.write('chain-proposals', value.id, { ...old.value, state: 'blocked', error: error.code }, old.revision);
          });
        }
        return jobs.finish(claim, { state: 'waiting', retryAt: now() + 60000,
          result: { error: error.code ?? 'execution_unavailable' } });
      }
    }
  };
  return api;
}
