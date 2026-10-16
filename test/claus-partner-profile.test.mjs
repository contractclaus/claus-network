import test from 'node:test';
import assert from 'node:assert/strict';
import { CLAUS_PARTNER_POLICY, CLAUS_PARTNER_POLICY_HASH, inspectClausPartnerProfile } from '../adapters/claus-partner-profile.mjs';
import {digest} from '../src/shared/index.mjs';

const pins = { partnerId: '11111111-1111-4111-8111-111111111111',
  policyOwner: '0x' + '11'.repeat(20), policyExecutor: '0x' + '22'.repeat(20),
  kernelSourceHash: 'sha256:' + 'a'.repeat(64), activeAfter: '2026-10-16T19:00:00.000Z' };
const now = Date.parse('2026-10-16T20:00:00.000Z');
const capability = () => ({ ...pins, schemaVersion: 'programmable.partner-launch-profile.v1',
  profileId: CLAUS_PARTNER_POLICY.profileId, policyHash: CLAUS_PARTNER_POLICY_HASH,
  policy: structuredClone(CLAUS_PARTNER_POLICY), state: 'enabled', launchAuthorized: false,
  assignmentHash:digest({schemaVersion:'programmable.claus-partner-assignment.v1',...pins,mode:'enabled'}),
  automaticAdmissionAvailable:true,admissionState:'scoped-receipt-required',
  admissionEndpoint:'/v1/partner/launch-admissions',receiptOrigin:'https://claus-network-api.vercel.app',
  requestEndpoint: '/v3/custom-launches', preflightEndpoint: '/v3/custom-launches/preflight',
  requestProfileVersion: '3.6.0', requestFieldsAdded: [], walletSigningAuthority: false });

test('matching authenticated profile does not grant launch, funding or signing authority', () => {
  const result = inspectClausPartnerProfile(capability(), pins, now);
  assert.equal(result.state, 'profile_ready');
  assert.equal(result.launchAuthorized, false); assert.equal(result.walletSigned, false);
  assert.equal(result.transactionPrepared, false); assert(!('partnerId' in result));
  assert.throws(() => inspectClausPartnerProfile(capability(), undefined, now), /claus_partner_pins_required/);
});

test('profile names and approved booleans cannot replace identity and exact safety policy', () => {
  for (const field of Object.keys(pins)) {
    const c = capability(); delete c[field];
    assert.equal(inspectClausPartnerProfile(c, pins, now).state, 'unavailable', field);
  }
  for (const [field, value] of [['quoteAsset', '0x' + '00'.repeat(20)], ['platformFeeBps', 0],
    ['maximumTotalFeeBps', 9900], ['openingSurchargePpm', 990000], ['creatorAuthority', 'owner'],
    ['immutablePrincipalLock', false], ['moduleFailure', 'revert'], ['protectionMayRestart', true]]) {
    const c = capability(); c.policy[field] = value;
    assert(inspectClausPartnerProfile(c, pins, now).problems.includes('partner_policy_mismatch'), field);
  }
  const wrong = capability(); wrong.partnerId = '22222222-2222-4222-8222-222222222222';
  assert(inspectClausPartnerProfile(wrong, pins, now).problems.includes('partner_assignment_mismatch'));
});

test('candidate, future assignment, altered endpoint and signing expansion stay unavailable', () => {
  for (const changes of [{ state: 'candidate' }, { launchAuthorized: true }, { automaticAdmissionAvailable:false },
    {admissionState:'manual-review-only'},{assignmentHash:digest('forged')},{ state: 'not_assigned' },
    { requestEndpoint: 'https://attacker.invalid' }, { requestFieldsAdded: ['approved'] },
    { walletSigningAuthority: true }, { requestProfileVersion: '999' }])
    assert.equal(inspectClausPartnerProfile({ ...capability(), ...changes }, pins, now).state, 'unavailable');
  assert.equal(inspectClausPartnerProfile(capability(), pins, Date.parse(pins.activeAfter) - 1).state, 'unavailable');
});
