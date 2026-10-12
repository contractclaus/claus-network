import { amount, copy, digest, integer, requireThat } from '../src/shared/index.mjs';
import { surplusTextRequest } from './surplus-text.mjs';

export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const address = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && BigInt(value) !== 0n;

// Pure validation, not an authenticated quote or resale permission. Only a
// trusted host that fetched this exact body's challenge over the fixed origin
// can promote a candidate to the inference domain's verified quote port.
// There is no signer, allowance setup, fallback to exact or paid retry here.
export function surplusPaymentCandidate({ profile, request, challenge, now = Date.now() }) {
  const wire = surplusTextRequest(profile, request);
  const endpoint = wire.origin + wire.path;
  requireThat(challenge?.x402Version === 2 && challenge.resource?.url === endpoint &&
    Array.isArray(challenge.accepts) && challenge.accepts.length > 0 && challenge.accepts.length <= 16,
  'surplus_payment_resource_mismatch');
  requireThat(profile.asset === 'eip155:8453/erc20:' + USDC.toLowerCase(), 'surplus_payment_asset_mismatch');
  const candidates = challenge.accepts.filter(q => q?.scheme === 'upto' && q.network === 'eip155:8453' &&
    typeof q.asset === 'string' && q.asset.toLowerCase() === USDC.toLowerCase());
  requireThat(candidates.length === 1, 'surplus_upto_required');
  const q = candidates[0];
  requireThat(address(q.payTo) && address(q.extra?.facilitatorAddress) && q.extra.name === 'USD Coin' &&
    q.extra.version === '2' && (!q.extra.assetTransferMethod || q.extra.assetTransferMethod === 'permit2'),
  'surplus_payment_domain_mismatch');
  integer(q.maxTimeoutSeconds, 1, 120);
  const maximum = amount(q.amount);
  requireThat(maximum > 0n && maximum <= amount(profile.maximumPerRequest), 'surplus_payment_limit');
  integer(now, 0);
  const expiresAt = Math.min(profile.expiresAt, now + q.maxTimeoutSeconds * 1000);
  requireThat(expiresAt > now, 'surplus_payment_expired');
  return { verified: false, requirement: copy(q), maximum: String(maximum), expiresAt,
    bodyHash: digest(wire.body), requestHash: digest(request), profileHash: digest(profile),
    challengeHash: digest(challenge), endpoint };
}
