import { amount, contentHash, digest, integer, requireThat, shape } from '../shared/index.mjs';
import { createPolicies } from '../policies/index.mjs';

export function createChainAdmission({ store, identity, now }) {
  async function owner(actor, reader = store) {
    const who = await identity.credential(actor, reader);
    const principal = (await reader.read('principals', who.principalId))?.value;
    const authority = (await reader.read('network', 'authority'))?.value;
    requireThat(who.kind === 'owner' && principal?.chainId === 1 && principal.address === authority?.ownerAddress, 'scope_denied');
    return true;
  }
  const policies = createPolicies({ store, now, authorize: (actor, _action, _scope, reader) => owner(actor, reader),
    schemas: { 'chain.admission': config => {
      shape(config, ['enabled', 'expiresAt', 'executor', 'executorCodeHash', 'targetArtifactHash',
        'reviewProjectId', 'reviewCaseId', 'reviewArtifactHash', 'maximumProjects',
        'maximumTransactionGasWei', 'maximumProjectGasWei', 'maximumTotalGasWei']);
      requireThat(typeof config.enabled === 'boolean' && /^0x[0-9a-fA-F]{40}$/.test(config.executor) &&
        /^0x[0-9a-fA-F]{64}$/.test(config.executorCodeHash), 'invalid_chain_admission');
      contentHash(config.targetArtifactHash); contentHash(config.reviewArtifactHash);
      requireThat(typeof config.reviewProjectId === 'string' && typeof config.reviewCaseId === 'string', 'invalid_chain_admission');
      integer(config.expiresAt, 1); integer(config.maximumProjects, 1, 64);
      requireThat(amount(config.maximumTransactionGasWei) > 0n && amount(config.maximumTransactionGasWei) <= 10000000000000000n &&
        amount(config.maximumProjectGasWei) >= amount(config.maximumTransactionGasWei) &&
        amount(config.maximumTotalGasWei) >= amount(config.maximumProjectGasWei), 'invalid_chain_admission');
    } }
  });
  async function active(reader = store) {
    if (!await reader.read('policy-active', 'chain.admission')) return null;
    return policies.active('chain.admission', reader);
  }
  async function admitted(reader = store) {
    const policy = await active(reader), config = policy?.config;
    requireThat(config?.enabled === true && config.expiresAt > now(), 'chain_public_not_enabled');
    const cap = (await reader.read('network-capabilities', 'chain'))?.value;
    requireThat(cap?.enabled && cap.chainId === 11155111 && cap.profile === 'claus-readonly-v1' &&
      cap.executor.toLowerCase() === config.executor.toLowerCase() && cap.executorCodeHash === config.executorCodeHash &&
      cap.targetArtifactHash === config.targetArtifactHash, 'chain_admission_changed');
    const review = (await reader.read('review-cases', config.reviewCaseId))?.value;
    requireThat(review?.state === 'reviewed' && review.projectId === config.reviewProjectId &&
      review.artifactHash === config.reviewArtifactHash, 'chain_scope_not_reviewed');
    // A policy switch cannot turn a generic completed review into public-scope approval.
    const assessment = (await reader.read('chain-admission-assessments', digest({
      executor: config.executor.toLowerCase(), targetArtifactHash: config.targetArtifactHash,
      reviewCaseId: config.reviewCaseId
    })))?.value;
    requireThat(assessment?.accepted === true && assessment.publicAdmission === true &&
      assessment.chainId === 11155111 && assessment.executorCodeHash === config.executorCodeHash &&
      assessment.reviewArtifactHash === config.reviewArtifactHash &&
      assessment.reviewedBuildHash === review.input?.buildHash, 'chain_scope_not_reviewed');
    return config;
  }
  return {
    active, admitted,
    async get(actor) { await owner(actor); return { policy: await active(), usage: (await store.read('public-chain-usage', 'global'))?.value ?? null }; },
    publish: (actor, input) => {
      requireThat(input.config.expiresAt <= now() + 30 * 86400000, 'invalid_chain_admission');
      return policies.publish({ actor, module: 'chain.admission', version: input.version, config: input.config });
    },
    activate: (actor, input) => policies.activate({ actor, module: 'chain.admission', version: input.version, expectedGeneration: input.expectedGeneration }),
    async reserveProject(tx, projectId) {
      const config = await admitted(tx);
      if (await tx.read('public-chain-projects', projectId)) return;
      const old = await tx.read('public-chain-usage', 'global');
      const used = old?.value ?? { projects: 0, reserved: '0', spent: '0' };
      requireThat(used.projects < config.maximumProjects, 'capacity_reached');
      await tx.write('public-chain-projects', projectId, { projectId, admittedAt: now(), reserved: '0', spent: '0' }, 0);
      await tx.write('public-chain-usage', 'global', { ...used, projects: used.projects + 1 }, old?.revision ?? 0);
    },
    async reserveGas(tx, { id, intent, maximum }) {
      const projectId = intent.authority.projectId ?? (await tx.read('chain-proposals', intent.authority.proposalId ?? 'none'))?.value.projectId;
      if (!projectId || !await tx.read('public-chain-projects', projectId)) return;
      const config = await admitted(tx), n = amount(maximum);
      requireThat(n <= amount(config.maximumTransactionGasWei), 'chain_gas_exhausted');
      const key = digest({ id });
      requireThat(!await tx.read('public-chain-reservations', key), 'idempotency_conflict');
      for (const [collection, key, ceiling] of [['public-chain-projects', projectId, config.maximumProjectGasWei],
        ['public-chain-usage', 'global', config.maximumTotalGasWei]]) {
        const row = await tx.read(collection, key), value = row.value;
        requireThat(amount(value.spent) + amount(value.reserved) + n <= amount(ceiling), 'chain_gas_exhausted');
        await tx.write(collection, key, { ...value, reserved: (amount(value.reserved) + n).toString() }, row.revision);
      }
      await tx.write('public-chain-reservations', key, { projectId, maximum, settled: false }, 0);
    },
    async finalizeGas(tx, { id, actual }) {
      const key = digest({ id }), reservation = await tx.read('public-chain-reservations', key);
      if (!reservation || reservation.value.settled) return;
      const { projectId, maximum } = reservation.value;
      requireThat(amount(actual) <= amount(maximum), 'chain_gas_receipt_mismatch');
      for (const [collection, key] of [['public-chain-projects', projectId], ['public-chain-usage', 'global']]) {
        const row = await tx.read(collection, key), value = row.value;
        requireThat(amount(value.reserved) >= amount(maximum), 'chain_gas_receipt_mismatch');
        await tx.write(collection, key, { ...value, reserved: (amount(value.reserved) - amount(maximum)).toString(),
          spent: (amount(value.spent) + amount(actual)).toString() }, row.revision);
      }
      await tx.write('public-chain-reservations', digest({ id }), { ...reservation.value, settled: true, actual }, reservation.revision);
    }
  };
}
