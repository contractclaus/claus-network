import { operatingExpiry, operatingWindowOpen, amount, contentHash, digest, integer, requireThat, shape } from '../shared/index.mjs';
import { createPolicies } from '../policies/index.mjs';

export function createChainAdmission({ store, identity, now, chainId = 11155111 }) {
  requireThat([1, 11155111].includes(chainId), 'unsupported_chain');
  const policyKey = chainId === 1 ? 'chain.mainnet.admission' : 'chain.admission';
  const capKey = chainId === 1 ? 'chain:1' : 'chain';
  const usageKey = chainId === 1 ? 'mainnet' : 'global';
  async function owner(actor, reader = store) {
    const who = await identity.credential(actor, reader);
    const principal = (await reader.read('principals', who.principalId))?.value;
    const authority = (await reader.read('network', 'authority'))?.value;
    requireThat(who.kind === 'owner' && principal?.chainId === 1 && principal.address === authority?.ownerAddress, 'scope_denied');
    return true;
  }
  const policies = createPolicies({ store, now, authorize: (actor, _action, _scope, reader) => owner(actor, reader),
    schemas: { [policyKey]: config => {
      shape(config, ['enabled', 'expiresAt', 'executor', 'executorCodeHash', 'targetArtifactHash',
        'reviewProjectId', 'reviewCaseId', 'reviewArtifactHash', 'maximumProjects',
        'maximumTransactionGasWei', 'maximumProjectGasWei', 'maximumTotalGasWei']);
      requireThat(typeof config.enabled === 'boolean' && /^0x[0-9a-fA-F]{40}$/.test(config.executor) &&
        /^0x[0-9a-fA-F]{64}$/.test(config.executorCodeHash), 'invalid_chain_admission');
      contentHash(config.targetArtifactHash); contentHash(config.reviewArtifactHash);
      requireThat(typeof config.reviewProjectId === 'string' && typeof config.reviewCaseId === 'string', 'invalid_chain_admission');
      operatingExpiry(config.expiresAt); integer(config.maximumProjects, 1, 64);
      requireThat(amount(config.maximumTransactionGasWei) > 0n && amount(config.maximumTransactionGasWei) <= 10000000000000000n &&
        amount(config.maximumProjectGasWei) >= amount(config.maximumTransactionGasWei) &&
        amount(config.maximumTotalGasWei) >= amount(config.maximumProjectGasWei), 'invalid_chain_admission');
    } }
  });
  async function active(reader = store) {
    if (!await reader.read('policy-active', policyKey)) return null;
    return policies.active(policyKey, reader);
  }
  async function admitted(reader = store) {
    const policy = await active(reader), config = policy?.config;
    requireThat(config?.enabled === true && operatingWindowOpen(config.expiresAt, now()), 'chain_public_not_enabled');
    const cap = (await reader.read('network-capabilities', capKey))?.value;
    requireThat(cap?.enabled && cap.chainId === chainId && cap.profile === 'claus-readonly-v1' &&
      cap.executor.toLowerCase() === config.executor.toLowerCase() && cap.executorCodeHash === config.executorCodeHash &&
      cap.targetArtifactHash === config.targetArtifactHash, 'chain_admission_changed');
    const review = (await reader.read('review-cases', config.reviewCaseId))?.value;
    requireThat(review?.state === 'reviewed' && review.projectId === config.reviewProjectId &&
      review.artifactHash === config.reviewArtifactHash, 'chain_scope_not_reviewed');
    // A policy switch cannot turn a generic completed review into public-scope approval.
    const assessment = (await reader.read('chain-admission-assessments', digest({
      executor: config.executor.toLowerCase(), targetArtifactHash: config.targetArtifactHash,
      reviewCaseId: config.reviewCaseId, ...(chainId === 1 ? { chainId } : {})
    })))?.value;
    requireThat(assessment?.accepted === true && assessment.publicAdmission === true &&
      assessment.chainId === chainId && assessment.executorCodeHash === config.executorCodeHash &&
      assessment.reviewArtifactHash === config.reviewArtifactHash &&
      assessment.reviewedBuildHash === review.input?.buildHash, 'chain_scope_not_reviewed');
    return config;
  }
  async function reserveProject(tx, projectId) {
    const config = await admitted(tx);
    const oldProject = await tx.read('public-chain-projects', projectId);
    if (oldProject) { requireThat((oldProject.value.chainId ?? 11155111) === chainId, 'project_chain_mismatch'); return; }
    const old = await tx.read('public-chain-usage', usageKey);
    const used = old?.value ?? { projects: 0, reserved: '0', spent: '0' };
    requireThat(used.projects < config.maximumProjects, 'capacity_reached');
    await tx.write('public-chain-projects', projectId, { projectId, chainId, admittedAt: now(), reserved: '0', spent: '0' }, 0);
    await tx.write('public-chain-usage', usageKey, { ...used, projects: used.projects + 1 }, old?.revision ?? 0);
  }
  return {
    active, admitted,
    async get(actor) { await owner(actor); return { policy: await active(), usage: (await store.read('public-chain-usage', usageKey))?.value ?? null }; },
    publish: (actor, input) => {
      requireThat(input.config.expiresAt === null || input.config.expiresAt <= now() + 30 * 86400000, 'invalid_chain_admission');
      return policies.publish({ actor, module: policyKey, version: input.version, config: input.config });
    },
    activate: (actor, input) => policies.activate({ actor, module: policyKey, version: input.version, expectedGeneration: input.expectedGeneration }),
    reserveProject,
    async reserveGas(tx, { id, intent, maximum }) {
      const projectId = intent.authority.projectId ?? (await tx.read('chain-proposals', intent.authority.proposalId ?? 'none'))?.value.projectId;
      requireThat(projectId, 'chain_project_missing');
      if (!await tx.read('public-chain-projects', projectId)) {
        const pilot = (await tx.read('review-pilots', projectId))?.value;
        if (chainId === 11155111 && pilot?.enabled && pilot.expiresAt > now()) return;
        const config = await admitted(tx);
        const binding = (await tx.read('chain-bindings', projectId))?.value;
        const registrationId = intent.authority.registrationId;
        const registration = registrationId && (await tx.read('chain-registrations', registrationId))?.value;
        requireThat((!binding || binding.executor?.toLowerCase() === config.executor.toLowerCase()) &&
          (!registration || registration.executor?.toLowerCase() === config.executor.toLowerCase()), 'chain_admission_changed');
        await reserveProject(tx, projectId);
      }
      requireThat(intent.chainId === undefined && chainId === 11155111 || intent.chainId === chainId, 'project_chain_mismatch');
      requireThat(((await tx.read('public-chain-projects', projectId)).value.chainId ?? 11155111) === chainId, 'project_chain_mismatch');
      const config = await admitted(tx), n = amount(maximum);
      requireThat(n <= amount(config.maximumTransactionGasWei), 'chain_gas_exhausted');
      const key = digest({ id });
      requireThat(!await tx.read('public-chain-reservations', key), 'idempotency_conflict');
      for (const [collection, key, ceiling] of [['public-chain-projects', projectId, config.maximumProjectGasWei],
        ['public-chain-usage', usageKey, config.maximumTotalGasWei]]) {
        const row = await tx.read(collection, key), value = row.value;
        requireThat(amount(value.spent) + amount(value.reserved) + n <= amount(ceiling), 'chain_gas_exhausted');
        await tx.write(collection, key, { ...value, reserved: (amount(value.reserved) + n).toString() }, row.revision);
      }
      await tx.write('public-chain-reservations', key, { projectId, chainId, maximum, settled: false }, 0);
    },
    async finalizeGas(tx, { id, actual }) {
      const key = digest({ id }), reservation = await tx.read('public-chain-reservations', key);
      if (!reservation || reservation.value.settled) return;
      requireThat((reservation.value.chainId ?? 11155111) === chainId, 'project_chain_mismatch');
      const { projectId, maximum } = reservation.value;
      requireThat(amount(actual) <= amount(maximum), 'chain_gas_receipt_mismatch');
      for (const [collection, key] of [['public-chain-projects', projectId], ['public-chain-usage', usageKey]]) {
        const row = await tx.read(collection, key), value = row.value;
        requireThat(amount(value.reserved) >= amount(maximum), 'chain_gas_receipt_mismatch');
        await tx.write(collection, key, { ...value, reserved: (amount(value.reserved) - amount(maximum)).toString(),
          spent: (amount(value.spent) + amount(actual)).toString() }, row.revision);
      }
      await tx.write('public-chain-reservations', digest({ id }), { ...reservation.value, settled: true, actual }, reservation.revision);
    }
  };
}
