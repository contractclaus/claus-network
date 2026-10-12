import { encodeAbiParameters, encodeFunctionData, hashTypedData, keccak256, recoverTypedDataAddress } from 'viem';
import { digest, requireThat } from '../src/shared/index.mjs';
import { createReadonlyTransactions } from './sepolia-transactions.mjs';
import { approvalMessage, approvalTypes, domain, validateModule, selectExecutorCapability } from './chain-read.mjs';
import { ClausApprovalExecutorAbi as executorAbi, ClausReadonlyProjectAbi as targetAbi } from './chain-abi.mjs';
import { authorityDenied } from './authorization.mjs';

export function createChainExecutor({ store, client, signer, sealer, chain, verification, artifacts, admission, chainId = 11155111, now = () => Date.now() }) {
  requireThat([1, 11155111].includes(chainId), 'unsupported_chain');
  const capKey = chainId === 1 ? 'chain:1' : 'chain';
  const read = (address, functionName, args = [], abi = executorAbi) => client.readContract({ address, abi, functionName, args });
  async function transact({ id, to = null, data, authority, expiresAt, authorize, validate = async () => {} }) {
    let currentChainState = true;
    const transactions = createReadonlyTransactions({ store, client, signer, sealer, now, chainId, finalized: chainId === 1,
      onReserve: admission?.reserveGas, onFinalize: admission?.finalizeGas,
      authorize: async (intent, reader) => {
        requireThat(intent.to === to && intent.data === data && intent.value === '0' &&
          digest(intent.authority) === digest(authority), 'executor_intent_mismatch');
        return currentChainState && authorize(reader);
      } });
    let status = await transactions.status(id);
    if (!status || status.state === 'prepared') {
      try { await validate(); }
      catch (error) {
        if (!authorityDenied(error)) throw error;
        currentChainState = false;
        if (!status) return { state: 'cancelled' };
      }
    }
    if (!status) {
      try {
        requireThat(await authorize(store) === true, 'transaction_not_authorized');
        await transactions.prepare({ id, to, data, authority, expiresAt });
      }
      catch (error) {
        if (authorityDenied(error)) return { state: 'cancelled' };
        throw error;
      }
    }
    status = await transactions.submit(id);
    return ['confirmed', 'reverted', 'cancelled'].includes(status.state) ? status : transactions.reconcile(id);
  }
  async function published(module, reader) {
    const review = (await reader.read('review-cases', module.caseId))?.value;
    requireThat(review?.state === 'reviewed' && review.projectId === module.projectId, 'review_not_complete');
    const source = await reader.read('public-sources', digest({ projectId: module.projectId, id: review.input.sourceHash }));
    requireThat(source?.value.published === true, 'source_not_published');
  }
  async function capability(executor) {
    const value = selectExecutorCapability((await store.read('network-capabilities', capKey))?.value, executor);
    // A withdrawn profile may still have a broadcast transaction to reconcile.
    // Fresh signatures/broadcasts check the current enabled profile below.
    await chain.capabilityMatches({ ...value, enabled: true }); return value;
  }
  async function currentCapability(cap, reader) {
    const value = selectExecutorCapability((await reader.read('network-capabilities', capKey))?.value, cap.executor);
    requireThat(value.enabled && digest(value) === digest({ ...cap, enabled: true }) &&
      value.executorPayer?.toLowerCase() === signer.address.toLowerCase(), 'executor_not_enabled');
  }
  const terminal = tx => tx.state === 'cancelled' ? { state: 'blocked', error: 'authority_or_window_closed' } :
    tx.state === 'reverted' ? { state: 'failed', error: 'transaction_reverted', transactionHash: tx.hash } : null;
  const deployment = {
    async step({ kind, value, artifact, signature, authorize }) {
      requireThat(value.chainId === chainId, 'wrong_chain');
      const cap = await capability(kind === 'project-register' ? value.executor : undefined);
      if (kind === 'module-deploy') {
        validateModule(artifact);
        const tx = await transact({ id: 'deploy:' + value.id, data: artifact.creationBytecode,
          authority: { kind, projectId: value.projectId, moduleId: value.id }, expiresAt: value.expiresAt,
          authorize: async reader => { await currentCapability(cap, reader); await published(value, reader); return authorize(reader); } });
        if (terminal(tx)) return terminal(tx);
        if (tx.state !== 'confirmed') return { state: 'deploying', transactionHash: tx.hash };
        const address = tx.receipt.contractAddress;
        const codeHash = keccak256(await client.getCode({ address }));
        requireThat(codeHash === artifact.runtimeTemplateHash, 'deployed_code_mismatch');
        const proof = await verification.step({ address, artifact, creationTransaction: tx.hash });
        return { state: proof.state === 'verified' ? 'verified' : 'verifying', address, codeHash,
          transactionHash: tx.hash, receipt: tx.receipt, verification: proof };
      }
      requireThat(kind === 'project-register' && value.executor === cap.executor, 'unsupported_execution');
      requireThat(await chain.verifyRegistration(value, signature), 'invalid_signature');
      const data = encodeFunctionData({ abi: executorAbi, functionName: 'registerProject', args: [value.message, value.configuration, signature] });
      const tx = await transact({ id: 'register:' + value.id, to: value.executor, data,
        authority: { kind, projectId: value.projectId, registrationId: value.id }, expiresAt: value.message.expiresAt * 1000,
        authorize: async reader => {
          await currentCapability(cap, reader);
          const mandate = (await reader.read('mandates', value.mandateId))?.value;
          requireThat(mandate && !mandate.revokedAt && mandate.expiresAt > now() &&
            '0x' + digest(mandate).slice(7) === value.message.mandateHash, 'invalid_mandate');
          const module = (await reader.read('chain-modules', value.moduleId))?.value;
          await published(module, reader); return authorize(reader);
        } });
      if (terminal(tx)) return terminal(tx);
      if (tx.state !== 'confirmed') return { state: 'registering', transactionHash: tx.hash };
      const project = await read(value.executor, 'projects', [value.message.projectId]);
      requireThat(project[0].toLowerCase() === value.message.owner.toLowerCase() && project[2] === value.message.mandateHash,
        'registered_project_mismatch');
      const target = project[1];
      requireThat((await read(target, 'executor', [], targetAbi)).toLowerCase() === value.executor.toLowerCase() &&
        await read(target, 'projectId', [], targetAbi) === value.message.projectId, 'registered_project_mismatch');
      const targetArtifact = await artifacts.get(cap.artifactProjectId, cap.targetArtifactHash);
      const constructorArguments = encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes' }],
        [value.message.projectId, value.message.implementation, value.configuration]);
      const proof = await verification.step({ address: target, artifact: targetArtifact,
        constructorArguments, creationTransaction: tx.hash });
      return { state: proof.state === 'verified' ? 'verified' : 'verifying', transactionHash: tx.hash,
        binding: { profile: cap.profile, chainId, executor: value.executor, projectKey: value.message.projectId,
          owner: value.message.owner, target, codeHash: keccak256(await client.getCode({ address: target })),
          registrationTransaction: tx.hash, verification: proof } };
    }
  };
  const execution = {
    async step({ value, authorize }) {
      const p = value.proposal;
      const cap = await capability(p.executor);
      requireThat(p.chainId === chainId && p.executor === cap.executor && digest(p) === value.proposalHash, 'proposal_mismatch');
      const signed = (await store.read('claus-signed-approvals', value.id))?.value;
      requireThat(signed && value.decision?.decision === 'approve' && signed.decisionHash === value.decision.decisionHash &&
        signed.proposalHash === value.proposalHash, 'approval_missing');
      const evidenceHash = '0x' + digest({ proposalHash: value.proposalHash, reviewArtifactHash: value.reviewArtifactHash,
        decisionHash: signed.decisionHash }).slice(7);
      const message = approvalMessage(p, evidenceHash), typed = { domain: domain(p.executor, chainId), types: approvalTypes, primaryType: 'Approval', message };
      requireThat(digest(message) === digest(signed.message) && hashTypedData(typed) === signed.approvalHash &&
        (await recoverTypedDataAddress({ ...typed, signature: signed.signature })).toLowerCase() === signed.signer.toLowerCase() &&
        signed.signer.toLowerCase() === cap.approvalSigner.toLowerCase(), 'approval_mismatch');
      const binding = (await store.read('chain-bindings', value.projectId))?.value;
      const input = await artifacts.get(value.projectId, value.inputArtifactHash);
      requireThat(digest(input.proposal) === value.proposalHash && input.proposalHash === value.proposalHash,
        'decision_input_mismatch');
      const validate = () => chain.validateProposal(p, binding, input.evidence?.chain);
      const executionId = 'execute:' + value.id;
      async function fresh(reader) {
        await currentCapability(cap, reader);
        const module = (await reader.read('chain-modules', value.moduleId))?.value;
        await published(module, reader);
        return authorize(reader);
      }
      const executeData = encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: [message, p.configuration, signed.signature] });
      const queueData = encodeFunctionData({ abi: executorAbi, functionName: 'queue', args: [message, signed.signature] });
      const existingExecution = (await store.read('chain-transactions', executionId))?.value;
      let executed = null;
      if (existingExecution) {
        const tx = await transact({ id: executionId, to: p.executor, data: executeData,
          authority: { kind: 'execute', proposalId: value.id }, expiresAt: p.expiresAt * 1000, authorize: fresh,
          validate });
        if (terminal(tx)) return terminal(tx);
        if (tx.state !== 'confirmed') return { state: 'executing', executionTransaction: tx.hash };
        executed = tx;
      }
      let queued = null;
      if (!executed && await store.read('chain-transactions', 'queue:' + value.id)) {
        queued = await transact({ id: 'queue:' + value.id, to: p.executor, data: queueData,
          authority: { kind: 'queue', proposalId: value.id }, expiresAt: p.expiresAt * 1000, authorize: fresh,
          validate });
        if (terminal(queued)) return terminal(queued);
        if (queued.state !== 'confirmed') return { state: 'queueing', queueTransaction: queued.hash };
      }
      if (!executed && await read(p.executor, 'executionNonces', [p.projectKey, BigInt(p.nonce)])) {
        // A valid signature can be submitted by any relayer. Find the actual
        // successful event; nonce consumption alone could also be cancellation.
        const queued = (await store.read('chain-transactions', 'queue:' + value.id))?.value;
        const event = executorAbi.find(x => x.type === 'event' && x.name === 'UpgradeExecuted');
        const logs = await client.getLogs({ address: p.executor, event, args: { projectId: p.projectKey, approvalHash: signed.approvalHash },
          fromBlock: BigInt(queued?.receipt?.blockNumber ?? 0), toBlock: 'latest' });
        if (!logs.length) return { state: 'blocked', error: 'approval_cancelled' };
        const receipt = await client.getTransactionReceipt({ hash: logs.at(-1).transactionHash });
        const block = await client.getBlock({ blockNumber: receipt.blockNumber }), head = await client.getBlockNumber();
        requireThat(receipt.status === 'success' && receipt.blockHash === block.hash, 'execution_receipt_mismatch');
        if (head - receipt.blockNumber < 2n || chainId === 1 &&
          (await client.getBlock({ blockTag: 'finalized' })).number < receipt.blockNumber) return { state: 'executing' };
        executed = { hash: receipt.transactionHash, receipt: { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash } };
      }
      if (executed) {
        requireThat(Number(await read(p.target, 'version', [], targetAbi)) === p.fromVersion + 1 &&
          (await read(p.target, 'implementation', [], targetAbi)).toLowerCase() === p.implementation.toLowerCase() &&
          await read(p.target, 'configuration', [], targetAbi) === p.configuration, 'execution_state_mismatch');
        return { state: 'executed', execution: { chainId, address: p.target, implementation: p.implementation,
          version: p.fromVersion + 1, codeHash: p.toCodeHash, approvalHash: signed.approvalHash,
          transactionHash: executed.hash, blockNumber: executed.receipt.blockNumber, blockHash: executed.receipt.blockHash,
          explorerUrl: (chainId === 1 ? 'https://etherscan.io/tx/' : 'https://sepolia.etherscan.io/tx/') + executed.hash, verification: binding.verification } };
      }
      const latest = await client.getBlock({ blockTag: 'latest' });
      if (Number(latest.timestamp) >= p.expiresAt) return { state: 'failed', error: 'approval_expired' };
      queued ??= await transact({ id: 'queue:' + value.id, to: p.executor, data: queueData,
        authority: { kind: 'queue', proposalId: value.id }, expiresAt: p.expiresAt * 1000, authorize: fresh,
        validate });
      if (terminal(queued)) return terminal(queued);
      if (queued.state !== 'confirmed') return { state: 'queueing', queueTransaction: queued.hash };
      const readyAt = Number(await read(p.executor, 'readyAt', [signed.approvalHash]));
      if (Number(latest.timestamp) < readyAt) return { state: 'queued', queueTransaction: queued.hash, readyAt };
      const tx = await transact({ id: executionId, to: p.executor, data: executeData,
        authority: { kind: 'execute', proposalId: value.id }, expiresAt: p.expiresAt * 1000, authorize: fresh,
        validate });
      if (terminal(tx)) return terminal(tx);
      return { state: 'executing', executionTransaction: tx.hash, readyAt };
    }
  };
  return { deployment, execution };
}
