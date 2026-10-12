import test from 'node:test';
import assert from 'node:assert/strict';
import { surplusPaymentCandidate, USDC } from '../adapters/surplus-x402.mjs';
import { digest } from '../src/shared/index.mjs';

function fixture() {
  const profile = { id: 'fixture', version: '1', enabled: false, providerId: 'surplus', accountId: 'no-live-account',
    model: 'fixture-model', providers: ['fixture-provider'], asset: 'eip155:8453/erc20:' + USDC.toLowerCase(),
    fundingAccount: 'fixture', permissionHash: digest('no-permission'), dataPolicyHash: digest('fixture'),
    expiresAt: 1800000900000, maximumPerRequest: '1000', maxInputBytes: 100, maxOutputTokens: 100 };
  const request = { profileId: profile.id, profileHash: digest(profile), model: profile.model, input: 'test', maxOutputTokens: 8 };
  const challenge = { x402Version: 2, resource: { url: 'https://api.surplusintelligence.ai/v1/chat/completions' }, accepts: [{
    scheme: 'upto', network: 'eip155:8453', asset: USDC, amount: '40', payTo: '0x' + '11'.repeat(20), maxTimeoutSeconds: 120,
    extra: { name: 'USD Coin', version: '2', facilitatorAddress: '0x' + '22'.repeat(20), assetTransferMethod: 'permit2' }
  }] };
  return { profile, request, challenge, now: 1800000000000 };
}

test('challenge validation pins the body and profile without granting a payment or an authenticated quote', () => {
  const f = fixture(), result = surplusPaymentCandidate(f);
  assert.equal(result.verified, false); assert.equal(result.maximum, '40');
  assert.equal(result.expiresAt, f.now + 120000);
  f.request.input = 'different';
  const changed = surplusPaymentCandidate(f);
  assert.notEqual(changed.bodyHash, result.bodyHash); assert.notEqual(changed.requestHash, result.requestHash);
});

test('wrong resource, network, token, domain, exact fallback and excessive amounts are refused', () => {
  const changes = [ f => f.challenge.resource.url += '/other', f => f.challenge.x402Version = 1,
    f => f.challenge.accepts[0].network = 'eip155:1', f => f.challenge.accepts[0].asset = '0x' + '33'.repeat(20),
    f => f.challenge.accepts[0].scheme = 'exact', f => f.challenge.accepts[0].amount = '1001',
    f => f.challenge.accepts[0].amount = '0', f => f.challenge.accepts[0].amount = 40,
    f => f.challenge.accepts[0].payTo = '0x' + '00'.repeat(20),
    f => f.challenge.accepts[0].extra.assetTransferMethod = 'eip3009',
    f => f.challenge.accepts[0].extra.facilitatorAddress = 'unknown',
    f => f.challenge.accepts[0].maxTimeoutSeconds = 121,
    f => f.challenge.accepts.push(structuredClone(f.challenge.accepts[0])),
    f => f.profile.expiresAt = f.now ];
  for (const change of changes) { const f = fixture(); change(f); assert.throws(() => surplusPaymentCandidate(f)); }
});
