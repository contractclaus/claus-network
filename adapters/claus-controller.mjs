import { hashTypedData, recoverTypedDataAddress } from 'viem';
import { digest, requireThat } from '../src/shared/index.mjs';
import { approvalMessage, approvalTypes, domain, selectExecutorCapability } from './chain-read.mjs';
import { ClausApprovalExecutorAbi } from './chain-abi.mjs';
import { boundedResponse } from './imd.mjs';
import { authorityDenied } from './authorization.mjs';

// This host owns the dedicated testnet approval key, never the transaction
// payer or the network owner's key. Source and model prose are not commands.
export function createClausController({ store, chain, client, signer, secret, fetcher = fetch, now = () => Date.now() }) {
  async function executorAllowed(executor, reader) {
    const cap = selectExecutorCapability((await reader.read('network-capabilities', 'chain'))?.value, executor);
    requireThat(cap.enabled && cap.chainId === 11155111 && cap.profile === 'claus-readonly-v1' &&
      cap.approvalSigner?.toLowerCase() === signer.address.toLowerCase(), 'executor_not_enabled');
    return cap;
  }
  async function call(path, body, method = body ? 'POST' : 'GET') {
    const response = await fetcher('https://claus-agent.vercel.app/internal/network' + path, {
      method, headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(25000) });
    if ([404, 429, 503].includes(response.status)) return { state: 'unavailable', status: response.status };
    requireThat(response.ok, 'claus_review_unavailable');
    return JSON.parse(await boundedResponse(response));
  }
  return {
    async step({ value, input, authorize }) {
      requireThat(secret && digest(input.proposal) === value.proposalHash && input.proposalHash === value.proposalHash &&
        input.review.artifactHash === value.reviewArtifactHash && input.projectId === value.projectId, 'decision_input_mismatch');
      const expectedId = 'nr_' + digest(input).slice(7);
      let status = await call('/reviews/' + expectedId);
      const binding = (await store.read('chain-bindings', value.projectId))?.value;
      requireThat(binding, 'project_not_registered');
      let permitted = false;
      try {
        await chain.capabilityMatches(await executorAllowed(value.proposal.executor, store));
        permitted = await authorize(store) === true;
        if (permitted) await chain.validateProposal(value.proposal, binding, input.evidence?.chain);
      } catch (error) {
        if (!authorityDenied(error)) throw error;
        permitted = false;
      }
      if (!permitted) {
        const stopped = await call('/reviews/' + expectedId, null, 'DELETE');
        return { state: ['blocked', 'completed', 'failed'].includes(stopped.state) ? 'blocked' : 'reviewing',
          error: 'authority_revoked', reviewId: expectedId };
      }
      if (status.status === 404 || status.state === 'queued' && Date.parse(status.retryAt) <= now()) {
        await store.transaction(async tx => {
          await executorAllowed(value.proposal.executor, tx);
          await authorize(tx);
          const existing = await tx.read('claus-decision-requests', value.id);
          if (existing) requireThat(existing.value.inputHash === digest(input), 'decision_input_mismatch');
          else await tx.write('claus-decision-requests', value.id, { reviewId: expectedId, inputHash: digest(input), createdAt: now() }, 0);
        });
        status = await call('/reviews', input);
      }
      if (['failed', 'blocked'].includes(status.state)) return { state: status.state, error: 'claus_' + status.state, reviewId: expectedId };
      if (status.state !== 'completed') return { state: 'reviewing', reviewId: expectedId };
      const decision = status.result;
      requireThat(status.id === expectedId && decision?.inputHash === digest(input) && decision.proposalHash === value.proposalHash &&
        decision.reviewArtifactHash === value.reviewArtifactHash, 'decision_input_mismatch');
      const { decisionHash, ...unsignedDecision } = decision;
      requireThat(digest(unsignedDecision) === decisionHash && ['approve', 'reject'].includes(decision.decision), 'decision_hash_mismatch');
      if (decision.decision === 'reject') return { state: 'rejected', decision, reviewId: expectedId };
      const state = await chain.validateProposal(value.proposal, binding, input.evidence?.chain);
      requireThat(value.proposal.expiresAt > Math.floor(now() / 1000) + state.minDelaySeconds + 300, 'proposal_expiring');
      const currentSigner = await client.readContract({ address: value.proposal.executor,
        abi: ClausApprovalExecutorAbi, functionName: 'clausSigner' });
      requireThat(currentSigner.toLowerCase() === signer.address.toLowerCase(), 'approval_signer_changed');
      const evidenceHash = '0x' + digest({ proposalHash: value.proposalHash,
        reviewArtifactHash: value.reviewArtifactHash, decisionHash }).slice(7);
      const message = approvalMessage(value.proposal, evidenceHash);
      const typed = { domain: domain(value.proposal.executor), types: approvalTypes, primaryType: 'Approval', message };
      const approvalHash = hashTypedData(typed);
      await store.transaction(async tx => {
        await executorAllowed(value.proposal.executor, tx);
        await authorize(tx);
        const old = await tx.read('claus-signed-approvals', value.id);
        if (old) { requireThat(old.value.approvalHash === approvalHash, 'approval_conflict'); return; }
        const signature = await signer.signTypedData(typed);
        requireThat((await recoverTypedDataAddress({ ...typed, signature })).toLowerCase() === signer.address.toLowerCase(), 'invalid_signer_result');
        await tx.write('claus-signed-approvals', value.id, { proposalId: value.id, proposalHash: value.proposalHash,
          decisionHash, evidenceHash, approvalHash, message, signature, signer: signer.address, signedAt: now() }, 0);
      });
      return { state: 'approved', decision, reviewId: expectedId, evidenceHash, approvalHash };
    }
  };
}
