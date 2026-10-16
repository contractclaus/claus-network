import { createHash } from 'node:crypto';
import { canonical, digest, requireThat } from '../src/shared/index.mjs';

export const CLAUS_PARTNER_POLICY = Object.freeze({
  profileId: 'programmable.claus-quote.v1', chainId: '1',
  quoteAsset: '0x1b54e762aa34cf6e28e9c082f2848e28e45da6b8',
  platformFeeBps: 30, maximumTotalFeeBps: 1500, minimumFdvUsd: '15000',
  openingSurchargePpm: 0, buyerLimitBps: 200, recipientLimitBps: 200, protectionSeconds: 300,
  protectionMayRestart: false, immutablePrincipalLock: true, creatorAuthority: 'fixed-fees-only',
  policyExecution: 'external-staticcall-no-kernel-storage', moduleFailure: 'immutable-fee-fallback'
});
export const CLAUS_PARTNER_POLICY_HASH = 'sha256:' + createHash('sha256')
  .update(canonical(CLAUS_PARTNER_POLICY)).digest('hex');
const hash = value => /^sha256:[0-9a-f]{64}$/.test(value ?? '');
const address = value => typeof value === 'string' && /^0x(?!0{40}$)[0-9a-f]{40}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

// expected is protected service configuration, never request/model input.
// A matching profile permits further preparation, not review approval or signing.
// The authenticated provider must expose the exact server assignment before this
// adapter can accept it. Unassigned and candidate profiles always stay closed.
export function inspectClausPartnerProfile(capability, expected, now = Date.now()) {
  requireThat(uuid(expected?.partnerId) && address(expected.policyOwner) && address(expected.policyExecutor) &&
    hash(expected.kernelSourceHash) && typeof expected.activeAfter === 'string' &&
    Number.isFinite(Date.parse(expected.activeAfter)) && Number.isSafeInteger(now), 'claus_partner_pins_required');
  const problems = [];
  if (capability?.schemaVersion !== 'programmable.partner-launch-profile.v1' ||
    capability.profileId !== CLAUS_PARTNER_POLICY.profileId || capability.requestProfileVersion !== '3.6.0' ||
    capability.requestEndpoint !== '/v3/custom-launches' || capability.preflightEndpoint !== '/v3/custom-launches/preflight' ||
    !Array.isArray(capability.requestFieldsAdded) || capability.requestFieldsAdded.length !== 0)
    problems.push('partner_contract_mismatch');
  if (!capability?.policy || canonical(capability.policy) !== canonical(CLAUS_PARTNER_POLICY) ||
    capability.policyHash !== CLAUS_PARTNER_POLICY_HASH) problems.push('partner_policy_mismatch');
  if (capability?.partnerId !== expected.partnerId || capability?.kernelSourceHash !== expected.kernelSourceHash ||
    capability?.policyOwner !== expected.policyOwner || capability?.policyExecutor !== expected.policyExecutor ||
    capability?.activeAfter !== expected.activeAfter) problems.push('partner_assignment_mismatch');
  const assigned = {schemaVersion:'programmable.claus-partner-assignment.v1',partnerId:expected.partnerId,
    mode:'enabled',activeAfter:expected.activeAfter,kernelSourceHash:expected.kernelSourceHash,
    policyOwner:expected.policyOwner,policyExecutor:expected.policyExecutor};
  if (capability?.assignmentHash !== digest(assigned)) problems.push('partner_assignment_hash_mismatch');
  if (capability?.admissionEndpoint !== '/v1/partner/launch-admissions' ||
    capability?.receiptOrigin !== 'https://claus-network-api.vercel.app') problems.push('partner_admission_mismatch');
  if (capability?.state !== 'enabled' || capability?.automaticAdmissionAvailable !== true ||
    capability?.admissionState !== 'scoped-receipt-required' || capability?.launchAuthorized !== false ||
    Date.parse(expected.activeAfter) > now) problems.push('partner_profile_not_enabled');
  if (capability?.walletSigningAuthority !== false) problems.push('unexpected_signing_authority');
  return { state: problems.length ? 'unavailable' : 'profile_ready', problems,
    policyHash: CLAUS_PARTNER_POLICY_HASH, profileId: CLAUS_PARTNER_POLICY.profileId,
    observedAt: new Date(now).toISOString(),
    // Do not leak the private expected configuration into public discovery.
    launchAuthorized: false, transactionPrepared: false, walletSigned: false,
    requires: ['independent_project_identity', 'exact_reviewed_request', 'claus_approval',
      'provider_permit', 'funding_and_execution_admission'] };
}
