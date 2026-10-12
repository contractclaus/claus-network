import { encodeAbiParameters, keccak256, stringToHex, verifyTypedData } from 'viem';
import { ClausApprovalExecutorAbi as executorAbi, ClausReadonlyProjectAbi as targetAbi } from './chain-abi.mjs';
import { digest, requireThat } from '../src/shared/index.mjs';
import { createChainEvidence, validateBuildEvidence } from './chain-evidence.mjs';

export const CHAIN_ID = 11155111;
export const PROFILE = 'claus-readonly-v1';
// A replacement becomes the default for new registrations. Already signed
// registrations and existing projects keep their exact executor and artifacts.
// Retained entries are operator configuration, never client-supplied addresses.
export function selectExecutorCapability(current, executor = current?.executor) {
  requireThat(current && typeof executor === 'string', 'executor_not_enabled');
  const matches = value => value?.executor?.toLowerCase() === executor.toLowerCase();
  const selected = matches(current) ? current : current.retainedExecutors?.find(matches);
  requireThat(selected, 'executor_not_enabled');
  const result = { enabled: current.enabled === true && selected.enabled === true };
  for (const key of ['profile', 'chainId', 'executor', 'executorCodeHash', 'approvalSigner',
    'executorPayer', 'artifactProjectId', 'targetArtifactHash']) result[key] = selected[key];
  return result;
}
const fields = entries => entries.map(([name, type]) => ({ name, type }));
export const registrationTypes = { Registration: fields([
  ['projectId', 'bytes32'], ['owner', 'address'], ['salt', 'bytes32'], ['implementation', 'address'], ['codeHash', 'bytes32'],
  ['initCallHash', 'bytes32'], ['mandateHash', 'bytes32'], ['policyVersion', 'bytes32'], ['minDelaySeconds', 'uint64'], ['nonce', 'uint256'], ['expiresAt', 'uint64']
]) };
export const approvalTypes = { Approval: fields([
  ['projectId', 'bytes32'], ['chainId', 'uint256'], ['executor', 'address'], ['target', 'address'], ['fromVersion', 'uint64'],
  ['fromCodeHash', 'bytes32'], ['implementation', 'address'], ['toCodeHash', 'bytes32'], ['initCallHash', 'bytes32'],
  ['dependencySnapshotHash', 'bytes32'], ['evidenceHash', 'bytes32'], ['policyVersion', 'bytes32'], ['policyGeneration', 'uint64'],
  ['authorityGeneration', 'uint64'], ['clausGeneration', 'uint64'], ['mandateHash', 'bytes32'], ['nonce', 'uint256'], ['notBefore', 'uint64'], ['expiresAt', 'uint64']
]) };
export const domain = executor => ({ name: 'Claus Network', version: '1', chainId: CHAIN_ID, verifyingContract: executor });
export function approvalMessage(p, evidenceHash) {
  const { profile, configuration, projectKey, ...rest } = p;
  requireThat(profile === PROFILE && p.chainId === CHAIN_ID, 'unsupported_profile');
  return { ...rest, projectId: projectKey, initCallHash: keccak256(configuration), evidenceHash };
}
export function validateModule(artifact) {
  requireThat(artifact?.status === 'compiled' && artifact.profile?.profile === 'solidity-static-compile-v1' &&
    Object.keys(artifact.immutableReferences ?? {}).length === 0 && /^0x[0-9a-f]+$/.test(artifact.creationBytecode), 'unsupported_module');
  const functions = artifact.abi.filter(x => x.type === 'function');
  requireThat(functions.every(x => ['pure', 'view'].includes(x.stateMutability)) &&
    artifact.abi.every(x => !['receive', 'fallback'].includes(x.type) && (x.type !== 'constructor' || x.inputs.length === 0)) &&
    functions.some(x => x.name === 'evaluate' && x.inputs.map(y => y.type).join(',') === 'bytes,bytes' &&
      x.outputs.map(y => y.type).join(',') === 'bytes'), 'unsupported_module');
  requireThat(keccak256(artifact.runtimeTemplate) === artifact.runtimeTemplateHash, 'artifact_corrupt');
}

export function createChainRead({ client }) {
  const evidence = createChainEvidence({ client });
  async function correctChain() { requireThat(await client.getChainId() === CHAIN_ID, 'wrong_chain'); }
  async function capabilityMatches(capability) {
    await correctChain();
    requireThat(capability.enabled === true && capability.chainId === CHAIN_ID && capability.profile === PROFILE,
      'unsupported_profile');
    requireThat(keccak256(await client.getCode({ address: capability.executor })) === capability.executorCodeHash,
      'executor_code_changed');
  }
  const read = (address, functionName, args = [], abi = executorAbi) => client.readContract({ address, abi, functionName, args });
  async function state(binding) {
    await correctChain();
    const p = await read(binding.executor, 'projects', [binding.projectKey]);
    requireThat(p[1].toLowerCase() === binding.target.toLowerCase() && p[0].toLowerCase() === binding.owner.toLowerCase(), 'project_binding_changed');
    const [version, implementation, codeHash, clausGeneration, pendingSigner, pendingOwner] = await Promise.all([
      read(binding.target, 'version', [], targetAbi), read(binding.target, 'implementation', [], targetAbi),
      read(binding.target, 'implementationCodeHash', [], targetAbi), read(binding.executor, 'clausGeneration'),
      read(binding.executor, 'pendingSigner'), read(binding.executor, 'pendingProjectOwners', [binding.projectKey])
    ]);
    requireThat(p[7] && /^0x0{40}$/i.test(pendingSigner) && /^0x0{40}$/i.test(pendingOwner), 'project_suspended');
    return { owner: p[0], target: p[1], mandateHash: p[2], policyVersion: p[3], minDelaySeconds: Number(p[4]),
      policyGeneration: Number(p[5]), authorityGeneration: Number(p[6]), version: Number(version),
      implementation, codeHash, clausGeneration: Number(clausGeneration) };
  }
  async function moduleMatches(module) {
    requireThat(module.state === 'verified' && module.chainId === CHAIN_ID &&
      keccak256(await client.getCode({ address: module.address })) === module.codeHash, 'module_code_changed');
  }
  return {
    validateModule, state, capabilityMatches, validateBuildEvidence,
    captureEvidence: evidence.capture,
    async registration({ projectId, owner, module, configuration, mandateHash, minDelaySeconds, capability, expiresAt }) {
      await capabilityMatches(capability); await moduleMatches(module);
      requireThat(/^0x(?:[a-f0-9]{2}){0,8192}$/i.test(configuration) && Number.isSafeInteger(minDelaySeconds) &&
        minDelaySeconds >= 0 && minDelaySeconds <= 5 * 86400, 'invalid_registration');
      // Read the actual pinned executor: older deployments still enforce an
      // hour. Never prepare an owner signature for a registration it rejects.
      const minimum = await read(capability.executor, 'MIN_UPGRADE_DELAY');
      requireThat(minimum >= 0n && minimum <= BigInt(minDelaySeconds), 'executor_delay_required');
      const salt = keccak256(stringToHex(projectId));
      const projectKey = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [owner, salt]));
      const message = { projectId: projectKey, owner, salt, implementation: module.address, codeHash: module.codeHash,
        initCallHash: keccak256(configuration), mandateHash, policyVersion: '0x' + digest({ profile: PROFILE, version: 1 }).slice(7),
        minDelaySeconds, nonce: BigInt('0x' + digest({ projectId, module: module.id, configuration, expiresAt }).slice(7)).toString(), expiresAt };
      return { profile: PROFILE, chainId: CHAIN_ID, executor: capability.executor, configuration,
        domain: domain(capability.executor), types: registrationTypes, primaryType: 'Registration', message };
    },
    async verifyRegistration(prepared, signature) {
      return verifyTypedData({ address: prepared.message.owner, domain: prepared.domain,
        types: registrationTypes, primaryType: 'Registration', message: prepared.message, signature });
    },
    async proposal({ binding, module, configuration, dependencySnapshot, nonceSeed, now }) {
      await moduleMatches(module); const s = await state(binding);
      requireThat(dependencySnapshot?.implementation?.codeHash === module.codeHash, 'dependency_evidence_mismatch');
      requireThat(s.minDelaySeconds <= 5 * 86400, 'unsupported_delay');
      requireThat(/^0x(?:[a-f0-9]{2}){0,8192}$/i.test(configuration), 'invalid_configuration');
      return { profile: PROFILE, chainId: CHAIN_ID, executor: binding.executor, projectKey: binding.projectKey,
        target: binding.target, fromVersion: s.version, fromCodeHash: s.codeHash, implementation: module.address,
        toCodeHash: module.codeHash, configuration, dependencySnapshotHash: '0x' + digest(dependencySnapshot).slice(7),
        policyVersion: s.policyVersion, policyGeneration: s.policyGeneration, authorityGeneration: s.authorityGeneration,
        clausGeneration: s.clausGeneration, mandateHash: s.mandateHash, nonce: BigInt('0x' + digest(nonceSeed).slice(7)).toString(),
        notBefore: now, expiresAt: now + Math.max(86400, s.minDelaySeconds + 7200) };
    },
    async validateProposal(proposal, binding, snapshot) {
      requireThat(proposal.profile === PROFILE && proposal.chainId === CHAIN_ID &&
        proposal.executor.toLowerCase() === binding.executor.toLowerCase() && proposal.projectKey === binding.projectKey, 'proposal_mismatch');
      const s = await state(binding);
      requireThat(proposal.fromVersion === s.version && proposal.fromCodeHash === s.codeHash && proposal.mandateHash === s.mandateHash &&
        proposal.policyVersion === s.policyVersion && proposal.policyGeneration === s.policyGeneration &&
        proposal.authorityGeneration === s.authorityGeneration && proposal.clausGeneration === s.clausGeneration &&
        keccak256(await client.getCode({ address: proposal.implementation })) === proposal.toCodeHash, 'proposal_stale');
      await evidence.validate(snapshot, proposal);
      return s;
    }
  };
}
