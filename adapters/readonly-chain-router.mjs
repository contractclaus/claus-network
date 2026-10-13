import { requireThat } from '../src/shared/index.mjs';
import { validateModule, validateBuildEvidence } from './chain-read.mjs';
import { validateManagedModule } from './managed-module.mjs';
import { chainProfile, MANAGED_PROFILE, READONLY_PROFILE } from '../src/chain-deployments/profiles.mjs';

// Explicit chain/profile routing. Managed remains disabled until its own
// admission is installed; legacy absent-profile records always use readonly.
// Wallets, signal stores and vaults retain their separate adapters.
export function createReadonlyChainRouter({ sepolia, mainnet, managedSepolia, managedMainnet }) {
  const selected = (chainId, profile = READONLY_PROFILE) => {
    chainProfile(chainId, profile);
    requireThat([1, 11155111].includes(chainId), 'unsupported_chain');
    const value = profile === MANAGED_PROFILE ? (chainId === 1 ? managedMainnet : managedSepolia) : (chainId === 1 ? mainnet : sepolia);
    requireThat(value, 'chain_not_configured'); return value;
  };
  return {
    validateModule: (artifact, profile = READONLY_PROFILE) => {
      chainProfile(11155111, profile);
      return profile === MANAGED_PROFILE ? validateManagedModule(artifact) : validateModule(artifact);
    }, validateBuildEvidence,
    state: binding => selected(binding.chainId ?? 11155111, binding.profile).state(binding),
    capabilityMatches: cap => selected(cap.chainId, cap.profile).capabilityMatches(cap),
    captureEvidence: input => selected(input.module.chainId, input.module.profile).captureEvidence(input),
    registration: input => selected(input.capability.chainId, input.capability.profile).registration(input),
    verifyRegistration: (value, signature) => selected(value.chainId, value.profile).verifyRegistration(value, signature),
    proposal: input => selected(input.binding.chainId, input.binding.profile).proposal(input),
    validateProposal: (proposal, binding, evidence) => selected(proposal.chainId, proposal.profile).validateProposal(proposal, binding, evidence)
  };
}
