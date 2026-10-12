import { decodeAbiParameters, encodeAbiParameters, keccak256 } from 'viem';
import { ClausApprovalExecutorAbi, ClausReadonlyProjectAbi } from './chain-abi.mjs';
import { inspectCode } from './chain-evidence.mjs';
import { digest, integer, requireThat } from '../src/shared/index.mjs';

const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
const word = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const same = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
const zero = value => /^0x0{40}$/i.test(value);

// Read-only observation for the initial pure, directional-fee market profile.
// The host must obtain this admission from its trusted release configuration,
// not from the applicant. A successful read does not grant launch authority.
// Re-read immediately before authorizing a launch; never reuse stale evidence
// across a generation, owner, signer, policy or code change.
async function captureAt({ client, admission, blockTag }) {
  const a = admission;
  requireThat(a?.profile === 'claus-market-directional-fee-v1' && [1, 11155111].includes(a.chainId) &&
    ['executor', 'policy', 'owner', 'approvalSigner', 'module'].every(key => address(a[key])) &&
    ['executorCodeHash', 'policyCodeHash', 'moduleCodeHash', 'projectKey', 'mandateHash', 'policyVersion']
      .every(key => word(a[key])), 'invalid_market_policy_admission');
  integer(a.minimumDelaySeconds, 3600, 5 * 86400);
  integer(a.maximumFee, 0, 100000);
  for (const key of ['policyGeneration', 'authorityGeneration', 'clausGeneration']) integer(a[key], 1);
  requireThat(await client.getChainId() === a.chainId, 'wrong_chain');
  const block = await client.getBlock({ blockTag });
  const read = (at, abi, functionName, args = []) => client.readContract({ address: at, abi, functionName, args, blockNumber: block.number });
  const [executorCode, policyCode, moduleCode] = await Promise.all(['executor', 'policy', 'module']
    .map(key => client.getCode({ address: a[key], blockNumber: block.number })));
  for (const [name, code] of [['executor', executorCode], ['policy', policyCode], ['module', moduleCode]]) {
    requireThat(typeof code === 'string' && code !== '0x' && keccak256(code) === a[name + 'CodeHash'], 'market_policy_code_changed');
    // Pins the deployed direct contract profile; not a general purity proof.
    inspectCode(code);
  }
  const [project, signer, pendingSigner, pendingOwner, clausGeneration,
    executor, projectKey, implementation, implementationCodeHash, configuration, version] = await Promise.all([
    read(a.executor, ClausApprovalExecutorAbi, 'projects', [a.projectKey]),
    read(a.executor, ClausApprovalExecutorAbi, 'clausSigner'),
    read(a.executor, ClausApprovalExecutorAbi, 'pendingSigner'),
    read(a.executor, ClausApprovalExecutorAbi, 'pendingProjectOwners', [a.projectKey]),
    read(a.executor, ClausApprovalExecutorAbi, 'clausGeneration'),
    ...['executor', 'projectId', 'implementation', 'implementationCodeHash', 'configuration', 'version']
      .map(name => read(a.policy, ClausReadonlyProjectAbi, name))
  ]);
  requireThat(same(project[0], a.owner) && same(project[1], a.policy) &&
    same(executor, a.executor) && projectKey === a.projectKey, 'market_policy_not_registered');
  requireThat(project[7] === true && zero(pendingSigner) && zero(pendingOwner), 'market_policy_suspended');
  requireThat(same(signer, a.approvalSigner) && Number(clausGeneration) === a.clausGeneration &&
    project[2] === a.mandateHash && project[3] === a.policyVersion &&
    Number(project[4]) === a.minimumDelaySeconds && Number(project[5]) === a.policyGeneration &&
    Number(project[6]) === a.authorityGeneration, 'market_policy_authority_changed');
  requireThat(same(implementation, a.module) && implementationCodeHash === a.moduleCodeHash &&
    typeof configuration === 'string' && /^0x[0-9a-f]{128}$/i.test(configuration), 'market_policy_module_changed');
  const fees = decodeAbiParameters([{ type: 'uint24' }, { type: 'uint24' }], configuration);
  requireThat(encodeAbiParameters([{ type: 'uint24' }, { type: 'uint24' }], fees) === configuration.toLowerCase(),
    'market_policy_module_changed');
  requireThat(fees.every(fee => fee <= a.maximumFee), 'market_policy_fee_exceeds_ceiling');
  requireThat((await client.getBlock({ blockNumber: block.number })).hash === block.hash, 'evidence_block_changed');
  const result = { profile: a.profile, admissionHash: digest(a), chainId: a.chainId,
    blockNumber: block.number.toString(), blockHash: block.hash, blockTag,
    executor: a.executor, executorCodeHash: a.executorCodeHash, policy: a.policy, policyCodeHash: a.policyCodeHash,
    projectKey: a.projectKey, owner: a.owner, mandateHash: a.mandateHash, policyVersion: a.policyVersion,
    policyGeneration: a.policyGeneration, authorityGeneration: a.authorityGeneration, clausGeneration: a.clausGeneration,
    approvalSigner: a.approvalSigner, module: a.module, moduleCodeHash: a.moduleCodeHash,
    configuration, version: version.toString(), zeroToOneFee: fees[0], oneToZeroFee: fees[1],
    minimumDelaySeconds: a.minimumDelaySeconds, maximumFee: a.maximumFee,
    launchAuthorized: false };
  return { ...result, observationHash: digest(result) };
}

export function captureMarketPolicy({ client, admission }) {
  return captureAt({ client, admission, blockTag: 'finalized' });
}

// A recent revocation or update must not hide behind an older finalized state.
// This is a read-time check, not a permit or a promise about future transactions.
export async function validateMarketPolicy({ client, admission, observation }) {
  const { observationHash, ...saved } = observation ?? {};
  requireThat(observationHash === digest(saved) && saved.admissionHash === digest(admission) &&
    saved.blockTag === 'finalized', 'invalid_market_policy_observation');
  requireThat((await client.getBlock({ blockNumber: BigInt(saved.blockNumber) })).hash === saved.blockHash,
    'evidence_block_changed');
  const current = await captureAt({ client, admission, blockTag: 'latest' });
  const state = value => {
    const { blockNumber, blockHash, blockTag, observationHash, ...rest } = value;
    return rest;
  };
  requireThat(digest(state(current)) === digest(state(saved)), 'market_policy_observation_stale');
  return { observationHash, headBlockNumber: current.blockNumber, headBlockHash: current.blockHash,
    checkedAt: new Date().toISOString(), launchAuthorized: false };
}
