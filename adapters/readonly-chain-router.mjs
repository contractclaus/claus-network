import { requireThat } from '../src/shared/index.mjs';
import { validateModule, validateBuildEvidence } from './chain-read.mjs';

// Two explicit chains for the readonly evaluator. Signal stores and Inbox
// requests have their own chain-pinned adapters. Wallet and vault remain Sepolia-only. A chain is never selected from an untrusted RPC response.
export function createReadonlyChainRouter({ sepolia, mainnet }) {
  const selected = chainId => {
    requireThat([1, 11155111].includes(chainId), 'unsupported_chain');
    const value = chainId === 1 ? mainnet : sepolia;
    requireThat(value, 'chain_not_configured'); return value;
  };
  return {
    validateModule, validateBuildEvidence,
    state: binding => selected(binding.chainId ?? 11155111).state(binding),
    capabilityMatches: cap => selected(cap.chainId).capabilityMatches(cap),
    captureEvidence: input => selected(input.module.chainId).captureEvidence(input),
    registration: input => selected(input.capability.chainId).registration(input),
    verifyRegistration: (value, signature) => selected(value.chainId).verifyRegistration(value, signature),
    proposal: input => selected(input.binding.chainId).proposal(input),
    validateProposal: (proposal, binding, evidence) => selected(proposal.chainId).validateProposal(proposal, binding, evidence)
  };
}
