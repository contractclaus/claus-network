import { keccak256 } from 'viem';
import { digest, requireThat } from '../src/shared/index.mjs';
import { factoryAbi, signalAbi } from './signal-read.mjs';

export const SIGNAL_LIMITS = Object.freeze({ maximumInputBytes:2048, maximumOutputBytes:512, evaluationGas:200000,
  maximumWritesPerGrant:10000, maximumGrantSeconds:2592000, maximumDataSeconds:86400,
  minimumIntervalSeconds:1, multipleOwnerSignedGrants:true, assetCustody:false });

function buildMatches(build, hash, name) {
  requireThat(digest(build) === hash && build.contract === name && build.status === 'compiled' &&
    build.profile?.profile === 'solidity-static-compile-v1' && build.profile.compiler === '0.8.27+commit.40a35a09.Emscripten.clang' &&
    digest(build.standardInput) === build.inputHash && keccak256(build.runtimeTemplate) === build.runtimeTemplateHash, 'signal_evidence_invalid');
}
export function validateSignalFactory({factoryBuild,factoryBuildHash,executor,factoryCode}) {
  buildMatches(factoryBuild,factoryBuildHash,'ClausSignalFactory');
  const groups = Object.values(factoryBuild.immutableReferences ?? {});
  requireThat(groups.length === 1 && groups[0].length > 0, 'signal_evidence_invalid');
  let expected = factoryBuild.runtimeTemplate.slice(2);
  for (const ref of groups[0]) {
    requireThat(ref.length === 32 && ref.start >= 0 && (ref.start + 32)*2 <= expected.length &&
      /^0{64}$/.test(expected.slice(ref.start*2,(ref.start+32)*2)), 'signal_evidence_invalid');
    expected = expected.slice(0,ref.start*2) + executor.toLowerCase().slice(2).padStart(64,'0') + expected.slice((ref.start+32)*2);
  }
  requireThat('0x'+expected === factoryCode.toLowerCase(), 'signal_evidence_invalid');
}

// Factory provenance authenticates constructor execution; the complete runtime
// comparison permits differences only in compiler-declared immutable words.
export function validateSignalRuntime({ build, buildHash, factoryBuild, factoryBuildHash, executor, storeCode, factoryCode }) {
  buildMatches(build,buildHash,'ClausSignalStore'); buildMatches(factoryBuild,factoryBuildHash,'ClausSignalFactory');
  requireThat(digest(build.standardInput.sources) === digest(factoryBuild.standardInput.sources), 'signal_evidence_invalid');
  validateSignalFactory({factoryBuild,factoryBuildHash,executor,factoryCode});
  let masked = storeCode.slice(2).toLowerCase();
  const used = new Set();
  requireThat(masked.length === build.runtimeTemplate.length-2, 'signal_evidence_invalid');
  for (const refs of Object.values(build.immutableReferences ?? {})) {
    requireThat(Array.isArray(refs) && refs.length > 0, 'signal_evidence_invalid');
    let value;
    for (const ref of refs) {
      requireThat(Number.isSafeInteger(ref.start) && ref.start >= 0 && ref.length === 32 &&
        (ref.start+32)*2 <= masked.length && /^0{64}$/.test(build.runtimeTemplate.slice(2+ref.start*2,2+(ref.start+32)*2)), 'signal_evidence_invalid');
      const actual = masked.slice(ref.start*2,(ref.start+32)*2);
      requireThat(value === undefined || actual === value, 'signal_evidence_invalid'); value = actual;
      for(let i=ref.start;i<ref.start+32;i++){ requireThat(!used.has(i),'signal_evidence_invalid');used.add(i); }
      masked = masked.slice(0,ref.start*2)+'0'.repeat(64)+masked.slice((ref.start+32)*2);
    }
  }
  requireThat('0x'+masked === build.runtimeTemplate.toLowerCase(), 'signal_evidence_invalid');
}

export async function captureSignalConsumer({ client, consumer, blockNumber }) {
  const { signal:s, build, factoryBuild, review } = consumer;
  requireThat(s.state === 'verified' && s.profile === 'claus-signal-v1' && [1,11155111].includes(s.chainId) &&
    await client.getChainId() === s.chainId && review.complete === true && digest(review) === s.reviewArtifactHash, 'signal_evidence_invalid');
  const [storeCode, factoryCode] = await Promise.all([s.address,s.factory].map(address => client.getCode({address,blockNumber})));
  requireThat(keccak256(storeCode) === s.codeHash && keccak256(factoryCode) === s.factoryCodeHash, 'signal_evidence_invalid');
  validateSignalRuntime({build,buildHash:s.artifactHash,factoryBuild,factoryBuildHash:s.config.factoryArtifactHash,
    executor:s.executor,storeCode,factoryCode});
  const registered = await client.readContract({address:s.factory,abi:factoryAbi,functionName:'stores',args:[s.projectKey],blockNumber});
  requireThat(registered.toLowerCase() === s.address.toLowerCase(), 'signal_evidence_invalid');
  for (const [name,expected] of Object.entries({executor:s.executor,evaluator:s.evaluator,projectId:s.projectKey,feedId:s.feedId,schemaHash:s.schemaHash})) {
    const actual = await client.readContract({address:s.address,abi:signalAbi,functionName:name,blockNumber});
    requireThat(actual.toLowerCase() === expected.toLowerCase(), 'signal_evidence_invalid');
  }
  return { profile:s.profile,projectId:s.projectId,store:{address:s.address,code:storeCode,codeHash:s.codeHash},
    factory:{address:s.factory,code:factoryCode,codeHash:s.factoryCodeHash},evaluator:s.evaluator,executor:s.executor,
    projectKey:s.projectKey,feedId:s.feedId,schemaHash:s.schemaHash,limits:SIGNAL_LIMITS,
    dataTrust:'publisher-attested-public-data',build,buildHash:s.artifactHash,factoryBuild,factoryBuildHash:s.config.factoryArtifactHash,
    review:{provider:'imd-audit-v1',jobId:review.jobId,artifactHash:s.reviewArtifactHash,report:review.report,reportHash:digest(review.report)} };
}
