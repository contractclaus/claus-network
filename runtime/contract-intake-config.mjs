import { createPublicClient, http } from 'viem';
import { createContractInboxRead } from '../adapters/contract-intake.mjs';
import { digest, requireThat, shape, integer, contentHash } from '../src/shared/index.mjs';

// The public API receives only this public deployment pin. It never receives
// a signing key. Omitting the pin keeps all new intake admissions disabled.
export function contractIntakePorts(env = process.env, suppliedClient) {
  if (!env.CLAUS_CONTRACT_INTAKE_PROFILE) return {};
  const pin = JSON.parse(env.CLAUS_CONTRACT_INTAKE_PROFILE);
  shape(pin, ['chainId', 'inbox', 'codeHash', 'dispatcher', 'startBlock', 'reviewProjectId', 'reviewCaseId', 'reviewArtifactHash']);
  requireThat(pin.chainId === 11155111, 'unsupported_chain');
  integer(pin.startBlock, 1); contentHash(pin.reviewArtifactHash);
  const client = suppliedClient ?? createPublicClient({ transport: http('https://ethereum-sepolia-rpc.publicnode.com',
    { retryCount: 0, timeout: 15000 }), cacheTime: 0 });
  const chain = createContractInboxRead({ client, ...pin });
  async function admitted(reader) {
    const capability = (await reader.read('network-capabilities', 'contract-intake'))?.value;
    if (!capability?.enabled) return false;
    requireThat(capability.profileHash === digest(pin), 'intake_admission_changed');
    const assessment = (await reader.read('contract-intake-admissions', digest(pin)))?.value;
    const review = (await reader.read('review-cases', pin.reviewCaseId))?.value;
    requireThat(assessment?.accepted === true && assessment.profileHash === digest(pin) &&
      review?.projectId === pin.reviewProjectId && review.state === 'reviewed' &&
      review.artifactHash === pin.reviewArtifactHash, 'intake_review_not_admitted');
    return true;
  }
  return { enabled: true, chain, client, pin, verifyAdmission: admitted };
}

