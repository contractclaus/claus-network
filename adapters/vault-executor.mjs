import { encodeAbiParameters, keccak256 } from 'viem';
import { digest, requireThat } from '../src/shared/index.mjs';
import { createSepoliaTransactions } from './sepolia-transactions.mjs';
import { ClausReadonlyProjectAbi } from './chain-abi.mjs';
import { vaultAbi } from './vault-read.mjs';
import { authorityDenied } from './authorization.mjs';

export function createVaultExecutor({ store, client, signer, sealer, artifacts, verification, now = () => Date.now() }) {
  return { async step({ value, authorize }) {
    const artifact = await artifacts.get(value.artifactProjectId, value.artifactHash);
    requireThat(value.profile === 'claus-native-principal-v1' && artifact.contract === 'ClausNativeVault' &&
      /^0x[0-9a-f]+$/i.test(artifact.creationBytecode), 'unsupported_vault_profile');
    const constructorArguments = encodeAbiParameters([{ type: 'address' }], [value.policy.target]);
    const data = artifact.creationBytecode + constructorArguments.slice(2);
    let fresh = true;
    const authority = { kind: 'vault-deploy', vaultId: value.id };
    const transactions = createSepoliaTransactions({ store, client, signer, sealer, now,
      authorize: async (intent, reader) => {
        requireThat(intent.to === null && intent.data === data && digest(intent.authority) === digest(authority), 'executor_intent_mismatch');
        return fresh && authorize(reader);
      } });
    const id = 'vault:' + value.id; let tx = await transactions.status(id);
    if (!tx || tx.state === 'prepared') {
      try {
        requireThat(value.expiresAt > now(), 'vault_deployment_expired');
        requireThat(keccak256(await client.getCode({ address: value.policy.target })) === value.policy.codeHash, 'project_binding_changed');
        const [projectKey, executor] = await Promise.all(['projectId', 'executor'].map(functionName =>
          client.readContract({ address: value.policy.target, abi: ClausReadonlyProjectAbi, functionName })));
        requireThat(projectKey === value.policy.projectKey && executor.toLowerCase() === value.policy.executor.toLowerCase(), 'project_binding_changed');
        requireThat(await authorize(store) === true, 'transaction_not_authorized');
      } catch (error) { if (!authorityDenied(error)) throw error; fresh = false; if (!tx) return { state: 'blocked', error: error.code }; }
    }
    if (!tx) tx = await transactions.prepare({ id, to: null, data, authority, expiresAt: value.expiresAt });
    tx = await transactions.submit(id);
    if (!['confirmed', 'reverted', 'cancelled'].includes(tx.state)) tx = await transactions.reconcile(id);
    if (tx.state === 'cancelled') return { state: 'blocked', error: 'authority_or_window_closed' };
    if (tx.state === 'reverted') return { state: 'failed', error: 'transaction_reverted', transactionHash: tx.hash, receipt: tx.receipt };
    if (tx.state !== 'confirmed') return { state: 'submitted', transactionHash: tx.hash };
    const address = tx.receipt.contractAddress;
    const policy = await client.readContract({ address, abi: vaultAbi, functionName: 'admissionPolicy' });
    requireThat(policy.toLowerCase() === value.policy.target.toLowerCase(), 'project_binding_changed');
    const proof = await verification.step({ address, artifact, constructorArguments, creationTransaction: tx.hash });
    return { state: proof.state === 'verified' ? 'verified' : 'verifying', address,
      codeHash: keccak256(await client.getCode({ address })), transactionHash: tx.hash, receipt: tx.receipt, verification: proof };
  } };
}
