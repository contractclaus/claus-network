import { digest, requireThat } from '../src/shared/index.mjs';
import { boundedResponse } from './imd.mjs';

// Sourcify cannot attest an onchain metadata fingerprint when the compiler
// omitted it. Keep that distinction: accept only this managed compile profile,
// identical complete bytecode and the exact pinned compiler input instead.
function metadataFreeEvidence(matched, artifact, { chainId, address, creationTransaction, constructorArguments }) {
  if (artifact.profile?.profile !== 'solidity-managed-compile-v1' ||
      artifact.standardInput?.settings?.metadata?.appendCBOR !== false || constructorArguments !== '0x') return null;
  const normalized = value => {
    const copy = structuredClone(value);
    if (copy?.settings) delete copy.settings.outputSelection;
    return copy;
  };
  const empty = value => value && typeof value === 'object' && Object.keys(value).length === 0;
  if (String(matched.chainId) !== String(chainId) || matched.address?.toLowerCase() !== address.toLowerCase() ||
      matched.deployment?.transactionHash?.toLowerCase() !== creationTransaction.toLowerCase() ||
      matched.compilation?.compilerVersion !== artifact.profile.compiler.replace('.Emscripten.clang', '') ||
      matched.compilation?.fullyQualifiedName !== artifact.entry + ':' + artifact.contract ||
      !matched.stdJsonInput || digest(normalized(matched.stdJsonInput)) !== digest(normalized(artifact.standardInput)) ||
      !empty(artifact.immutableReferences) || !empty(matched.runtimeBytecode?.immutableReferences)) return null;
  for (const [kind, expected] of [['creationBytecode', artifact.creationBytecode], ['runtimeBytecode', artifact.runtimeTemplate]]) {
    const code = matched[kind];
    if (typeof expected !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(expected) ||
        code?.onchainBytecode !== expected || code?.recompiledBytecode !== expected ||
        !Array.isArray(code.transformations) || code.transformations.length || !empty(code.cborAuxdata)) return null;
  }
  if (!['match', 'exact_match'].includes(matched.runtimeMatch) || !['match', 'exact_match'].includes(matched.creationMatch)) return null;
  return { kind: 'complete-bytecode-without-metadata', artifactHash: digest(artifact),
    standardInputHash: digest(artifact.standardInput), creationTransaction, metadataFingerprintVerified: false };
}

// Verification only; no explorer response can create a signing request.
export function createSourceVerification({ store, etherscanKey, chainId = 11155111, fetcher = fetch, now = () => Date.now() }) {
  requireThat([1, 11155111].includes(chainId), 'unsupported_chain');
  async function request(url, options = {}) {
    const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(25000) });
    requireThat(response.ok, 'verification_service_unavailable');
    return JSON.parse(await boundedResponse(response, 4000000));
  }
  async function etherscan(values) {
    requireThat(etherscanKey, 'verification_not_configured');
    const { action, ...parameters } = values;
    const query = new URLSearchParams({ chainid: String(chainId), module: 'contract', action, apikey: etherscanKey });
    if (action === 'verifysourcecode') return request('https://api.etherscan.io/v2/api?' + query, {
      method: 'POST', body: new URLSearchParams(parameters) });
    for (const [key, value] of Object.entries(parameters)) query.set(key, value);
    return request('https://api.etherscan.io/v2/api?' + query);
  }
  return {
    async step({ address, artifact, constructorArguments = '0x', creationTransaction }) {
      requireThat(/^0x[0-9a-fA-F]{40}$/.test(address) && /^0x[0-9a-f]{64}$/i.test(creationTransaction) &&
        /^0x(?:[0-9a-f]{2})*$/i.test(constructorArguments), 'invalid_verification');
      const id = digest({ chainId, address: address.toLowerCase() });
      const inputHash = digest({ standardInput: artifact.standardInput, entry: artifact.entry, contract: artifact.contract,
        constructorArguments, creationTransaction });
      let row = await store.read('chain-verifications', id);
      if (row) requireThat(row.value.inputHash === inputHash, 'verification_input_changed');
      let value = row?.value ?? { id, address, chainId, inputHash, state: 'pending' };
      if (value.state === 'verified') return value;
      if (value.nextCheckAt > now()) return value;
      value.etherscanSubmissionCount ??= value.etherscanGuid || value.etherscanAttemptAt ? 1 : 0;
      async function save() {
        row = await store.transaction(async tx => {
          const current = await tx.read('chain-verifications', id);
          requireThat((current?.revision ?? 0) === (row?.revision ?? 0), 'verification_step_stale');
          return tx.write('chain-verifications', id, value, current?.revision ?? 0);
        });
      }
      if (!value.sourcifyId && !value.sourcifyAlreadyVerified) {
        const response = await fetcher('https://sourcify.dev/server/v2/verify/' + chainId + '/' + address, {
          method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(25000),
          body: JSON.stringify({ stdJsonInput: artifact.standardInput, compilerVersion: artifact.profile.compiler.replace('.Emscripten.clang', ''),
            contractIdentifier: artifact.entry + ':' + artifact.contract, creationTransactionHash: creationTransaction }) });
        requireThat(response.ok || response.status === 409, 'verification_service_unavailable');
        const result = JSON.parse(await boundedResponse(response));
        value = { ...value, sourcifyId: result.verificationId ?? null,
          sourcifyAlreadyVerified: response.status === 409 }; await save();
      }
      try {
        const fields = artifact.profile?.profile === 'solidity-managed-compile-v1'
          ? 'creationMatch,runtimeMatch,deployment,compilation,stdJsonInput,runtimeBytecode,creationBytecode'
          : 'creationMatch,runtimeMatch';
        const matched = await request('https://sourcify.dev/server/v2/contract/' + chainId + '/' + address + '?fields=' + fields);
        value = { ...value, runtimeMatch: typeof matched.runtimeMatch === 'string' ? matched.runtimeMatch : null,
          creationMatch: typeof matched.creationMatch === 'string' ? matched.creationMatch : null,
          metadataFreeEvidence: metadataFreeEvidence(matched, artifact, { chainId, address, creationTransaction, constructorArguments }) };
      } catch { /* A newly indexed deployment can still be pending. */ }
      const source = await etherscan({ action: 'getsourcecode', address });
      const entry = source.status === '1' && Array.isArray(source.result) ? source.result[0] : null;
      value.etherscanVerified = !!entry?.SourceCode && entry.ContractName === artifact.contract;
      value.etherscanMatch = value.etherscanVerified ? entry.SimilarMatch ? 'similar' : 'exact' : null;
      if (!entry) {
        value.etherscanError = String(source.result).slice(0, 500);
        value.etherscanRefusals = Math.min((value.etherscanRefusals ?? 0) + 1, 7);
        value.nextCheckAt = now() + Math.min(3600000, 60000 * 2 ** (value.etherscanRefusals - 1));
        value.checkedAt = now(); await save(); return value;
      }
      if (!value.etherscanVerified && !value.etherscanGuid && value.etherscanSubmissionCount < 3 &&
          (!value.etherscanAttemptAt || value.etherscanAttemptAt < now() - 60000)) {
        // Reserve before the external call, including uncertain/failed replies.
        value.etherscanSubmissionCount++; value.etherscanAttemptAt = now();
        value.nextCheckAt = now() + 60000;
        await save();
        const reserved = { count: value.etherscanSubmissionCount, at: value.etherscanAttemptAt };
        const submission = await etherscan({ action: 'verifysourcecode', contractaddress: address,
          sourceCode: JSON.stringify(artifact.standardInput), codeformat: 'solidity-standard-json-input',
          contractname: artifact.entry + ':' + artifact.contract, compilerversion: 'v' + artifact.profile.compiler.replace('.Emscripten.clang', ''),
          constructorArguments: constructorArguments.slice(2), constructorArguements: constructorArguments.slice(2) });
        if (submission.status === '1') requireThat(typeof submission.result === 'string' &&
          submission.result.length > 0 && submission.result.length <= 256, 'verification_invalid_response');
        // Keep an accepted provider ID even if a concurrent read advanced the
        // row. Apply its result only to the reservation that sent this request.
        row = await store.transaction(async tx => {
          const current = await tx.read('chain-verifications', id);
          requireThat(current?.value.inputHash === inputHash, 'verification_input_changed');
          if (submission.status === '1') {
            const attemptId = digest({ id, guid: submission.result });
            if (!await tx.read('chain-verification-attempts', attemptId)) await tx.write('chain-verification-attempts', attemptId,
              { id, guid: submission.result, inputHash, acceptedAt: now() }, 0);
          }
          if (current.value.etherscanSubmissionCount !== reserved.count || current.value.etherscanAttemptAt !== reserved.at ||
              current.value.state === 'verified' || current.value.etherscanGuid) return current;
          const next = { ...current.value };
          if (submission.status === '1') {
            next.etherscanGuid = submission.result; next.etherscanRefusals = 0;
            delete next.etherscanError; delete next.nextCheckAt;
          } else {
            next.etherscanError = String(submission.result).slice(0, 500);
            // These explicit refusals created no verification job. Uncertain
            // sends and actual verification failures still consume the cap.
            if (/invalid api key|rate limit|daily limit|unable to locate contractcode|invalid action/i.test(next.etherscanError)) {
              next.etherscanSubmissionCount--;
              next.etherscanRefusals = Math.min((next.etherscanRefusals ?? 0) + 1, 7);
              next.nextCheckAt = now() + Math.min(3600000, 60000 * 2 ** (next.etherscanRefusals - 1));
            }
          }
          return tx.write('chain-verifications', id, next, current.revision);
        });
        value = row.value;
        if (value.state === 'verified') return value;
      }
      if (value.etherscanGuid && !value.etherscanVerified && !value.etherscanRetryExhausted) {
        const status = await etherscan({ action: 'checkverifystatus', guid: value.etherscanGuid });
        if (status.status === '1' || /pending|queue|^pass\b/i.test(status.result)) delete value.etherscanError;
        else if (status.status === '0') {
          value.etherscanError = String(status.result).slice(0, 500);
          // Retry only an explicitly failed verification of the same immutable
          // input. Queue, rate-limit and transport errors retain their GUID.
          if (/^fail\b|unable to verify|verification failed/i.test(value.etherscanError)) {
            const guid = value.etherscanGuid;
            await store.transaction(async tx => {
              const attemptId = digest({ id, guid });
              const previous = await tx.read('chain-verification-attempts', attemptId);
              await tx.write('chain-verification-attempts', attemptId,
                { ...previous?.value, id, guid, inputHash, error: value.etherscanError, failedAt: now() }, previous?.revision ?? 0);
            });
            delete value.etherscanGuid;
          } else value.nextCheckAt = now() + 3600000;
        }
      }
      value.etherscanRetryExhausted = !value.etherscanVerified && !value.etherscanGuid && value.etherscanSubmissionCount >= 3;
      value.etherscanState = value.etherscanVerified ? 'verified' : value.etherscanRetryExhausted ? 'operator_action_required' : 'pending';
      if (value.etherscanRetryExhausted) value.nextCheckAt = now() + 3600000;
      value = { ...value, checkedAt: now(), explorerUrl: (chainId === 1 ? 'https://etherscan.io/address/' : 'https://sepolia.etherscan.io/address/') + address + '#code',
        sourcifyUrl: 'https://repo.sourcify.dev/' + chainId + '/' + address };
      if (value.etherscanVerified) delete value.etherscanError;
      if ((value.runtimeMatch === 'exact_match' && value.creationMatch === 'exact_match' || value.metadataFreeEvidence) &&
          value.etherscanVerified) value.state = 'verified';
      await save(); return value;
    }
  };
}
