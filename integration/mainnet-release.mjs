import { encodeDeployData, encodeAbiParameters, getContractAddress, keccak256 } from 'viem';
import { digest, requireThat } from '../src/shared/index.mjs';
import { createArtifactStore } from '../src/artifact-store/index.mjs';
import { createReadonlyTransactions } from '../adapters/sepolia-transactions.mjs';

// Operator-only release functions. This module is not reachable from HTTP/MCP.
// The caller retains the owner authorization and the existing signing journal.
export function mainnetDeployment(plan, artifact) {
  requireThat(plan.chainId === 1 && plan.profile === 'claus-readonly-v1' &&
    plan.automaticRefill === false && plan.buildHash === digest(artifact), 'release_plan_mismatch');
  const args = [plan.approvalSigner, plan.recoveryOwner, BigInt(plan.recoveryDelay)];
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.creationBytecode, args });
  const constructorArguments = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint64' }], args);
  requireThat(keccak256(data) === plan.deploymentDataHash && constructorArguments === plan.constructorArguments,
    'release_plan_mismatch');
  const address = getContractAddress({ from: plan.executorPayer, nonce: 0n });
  requireThat(address.toLowerCase() === plan.expectedExecutor.toLowerCase(), 'release_plan_mismatch');
  return { data, constructorArguments, address };
}
export function requireMainnetApproval(plan, authorization, assessment) {
  const roles=[plan.approvalSigner,plan.executorPayer,plan.recoveryOwner];
  requireThat(roles.every(v=>/^0x[0-9a-fA-F]{40}$/.test(v)) &&
    new Set(roles.map(v=>v.toLowerCase())).size===3 && plan.recoveryDelay===172800,'release_roles_mismatch');
  requireThat(Number.isSafeInteger(plan.bootstrapMaximumGas) && plan.bootstrapMaximumGas>0 &&
    plan.bootstrapMaximumGas<=30000000,'release_gas_limit');
  // This record is retained evidence of the human's exact approval, supplied
  // only by the trusted operator. It is not a signature or a public API input.

  requireThat(authorization?.approved === true && authorization.planHash === digest(plan) &&
    authorization.owner?.toLowerCase() === plan.recoveryOwner.toLowerCase() &&
    authorization.revoked !== true && Number.isSafeInteger(authorization.expiresAt), 'exact_mainnet_authorization_required');
  requireThat(assessment?.status === 'accepted-for-mainnet-readonly' && assessment.chainId === 1 &&
    assessment.sourceCommit === plan.runtimeCommit && assessment.contractCommit === plan.contractCommit &&
    assessment.buildHash === plan.buildHash, 'mainnet_scope_not_reviewed');
}
export async function deployMainnetRelease({ store, client, signer, sealer, verification,
  plan, artifact, authorization, assessment, now = () => Date.now() }) {
  requireMainnetApproval(plan, authorization, assessment);
  requireThat(await client.getChainId() === 1 && signer.address.toLowerCase() === plan.executorPayer.toLowerCase(), 'wrong_release_signer');
  const { data, constructorArguments, address } = mainnetDeployment(plan, artifact);
  const id = 'bootstrap:mainnet-readonly:' + digest(plan).slice(7);
  const authority = { kind: 'approved-mainnet-bootstrap', planHash: digest(plan), assessmentHash: digest(assessment) };
  const txs = createReadonlyTransactions({ store, client, signer, sealer, chainId: 1, finalized: true,
    limits: { gas: String(plan.bootstrapMaximumGas), cost: plan.bootstrapMaximumWei },
    authorize: async intent => intent.to === null && intent.data === data && intent.value === '0' &&
      digest(intent.authority) === digest(authority) && authorization.revoked !== true && now() < authorization.expiresAt });
  let tx = await txs.status(id);
  if (!tx) {
    requireThat(await client.getTransactionCount({ address: signer.address, blockTag: 'pending' }) === 0, 'release_nonce_changed');
    requireThat(now() < authorization.expiresAt, 'release_authorization_expired');
    tx = await txs.prepare({ id, to: null, data, authority, expiresAt: authorization.expiresAt });
  }
  if (tx.state === 'prepared') tx = await txs.submit(id);
  tx = await txs.reconcile(id);
  if (tx.state !== 'confirmed') return tx;
  requireThat(tx.nonce === 0 && tx.intent.data === data && tx.receipt.contractAddress.toLowerCase() === address.toLowerCase(), 'release_deployment_mismatch');
  const read = functionName => client.readContract({ address, abi: artifact.abi, functionName, blockTag: 'finalized' });
  requireThat((await read('clausSigner')).toLowerCase() === plan.approvalSigner.toLowerCase() &&
    (await read('recoveryOwner')).toLowerCase() === plan.recoveryOwner.toLowerCase() &&
    await read('recoveryDelay') === BigInt(plan.recoveryDelay) && await read('MIN_UPGRADE_DELAY') === 0n,
    'release_roles_mismatch');
  const proof = await verification.step({ address, artifact, constructorArguments, creationTransaction: tx.hash });
  return { state: proof.state, address, transactionHash: tx.hash, receipt: tx.receipt,
    codeHash: keccak256(await client.getCode({ address, blockTag: 'finalized' })), verification: proof,
    planHash: digest(plan), sourceCommit: plan.runtimeCommit, chainId: 1 };
}
export async function stageMainnetCapability({ store, plan, authorization, assessment, deployment, client, artifact }) {
  requireMainnetApproval(plan, authorization, assessment);
  requireThat(Date.now() < authorization.expiresAt, 'release_authorization_expired');
  const { data, address } = mainnetDeployment(plan, artifact);
  const target=await createArtifactStore({store}).get(plan.artifactProjectId,plan.targetArtifactHash);
  requireThat(target.contract==='ClausReadonlyProject' && target.standardInput && target.creationBytecode,'release_target_artifact_missing');
  const proof=(await store.read('chain-verifications',digest({chainId:1,address:address.toLowerCase()})))?.value;
  requireThat(proof?.state==='verified' && proof.etherscanVerified &&
    digest(proof)===digest(deployment.verification),'stored_verification_required');
  requireThat(deployment.state === 'verified' && deployment.planHash === digest(plan) &&
    deployment.address.toLowerCase() === address.toLowerCase() && deployment.verification.creationMatch === 'exact_match' &&
    deployment.verification.runtimeMatch === 'exact_match', 'exact_verified_release_required');
  requireThat(await client.getChainId() === 1, 'wrong_chain');
  const [tx, receipt, finalized, code] = await Promise.all([client.getTransaction({ hash: deployment.transactionHash }),
    client.getTransactionReceipt({ hash: deployment.transactionHash }), client.getBlock({ blockTag: 'finalized' }),
    client.getCode({ address, blockTag: 'finalized' })]);
  requireThat(tx.from.toLowerCase() === plan.executorPayer.toLowerCase() && tx.nonce === 0 && tx.to === null &&
    tx.input === data && tx.value === 0n && receipt.status === 'success' && receipt.blockNumber <= finalized.number &&
    receipt.contractAddress.toLowerCase() === address.toLowerCase() &&
    (await client.getBlock({ blockNumber: receipt.blockNumber })).hash === receipt.blockHash &&
    keccak256(code) === deployment.codeHash, 'release_deployment_mismatch');
  const cap = { enabled: true, profile: plan.profile, chainId: 1, executor: address.toLowerCase(),
    executorCodeHash: deployment.codeHash, approvalSigner: plan.approvalSigner, executorPayer: plan.executorPayer,
    artifactProjectId: plan.artifactProjectId, targetArtifactHash: plan.targetArtifactHash };
  const scope = { accepted: true, publicAdmission: true, chainId: 1, executorCodeHash: cap.executorCodeHash,
    reviewArtifactHash: plan.coreReviewArtifactHash, reviewedBuildHash: plan.buildHash, mainnetAssessmentHash: digest(assessment) };
  const key = digest({ executor: cap.executor, targetArtifactHash: cap.targetArtifactHash, reviewCaseId: plan.coreReviewCaseId, chainId: 1 });
  await store.transaction(async tx => {
    const core = (await tx.read('review-cases', plan.coreReviewCaseId))?.value;
    requireThat(core?.state === 'reviewed' && core.artifactHash === plan.coreReviewArtifactHash &&
      core.input?.buildHash === plan.buildHash, 'core_review_changed');
    for (const [collection, id, value] of [['network-capabilities', 'chain:1', cap], ['chain-admission-assessments', key, scope]]) {
      const old = await tx.read(collection, id);
      if (old) requireThat(digest(old.value) === digest(value), 'existing_mainnet_state_changed');
      else await tx.write(collection, id, value, 0);
    }
    await tx.event({ type: 'mainnet.capability_staged', planHash: digest(plan), at: Date.now() });
  });
  // This does not publish a sponsor policy. Use the existing owner-only
  // chain_admission_publish/activate operations with chainId=1 after runtime verification.
  return cap;
}
