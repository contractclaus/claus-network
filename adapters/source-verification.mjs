import { digest, requireThat } from '../src/shared/index.mjs';
import { boundedResponse } from './imd.mjs';

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
      async function save() {
        row = await store.transaction(async tx => {
          const current = await tx.read('chain-verifications', id);
          return tx.write('chain-verifications', id, value, current?.revision ?? 0);
        });
      }
      if (!value.sourcifyId) {
        const response = await fetcher('https://sourcify.dev/server/v2/verify/' + chainId + '/' + address, {
          method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(25000),
          body: JSON.stringify({ stdJsonInput: artifact.standardInput, compilerVersion: artifact.profile.compiler.replace('.Emscripten.clang', ''),
            contractIdentifier: artifact.entry + ':' + artifact.contract, creationTransactionHash: creationTransaction }) });
        const result = JSON.parse(await boundedResponse(response));
        requireThat(response.ok || response.status === 409, 'verification_service_unavailable');
        value = { ...value, sourcifyId: result.verificationId ?? null }; await save();
      }
      try {
        const matched = await request('https://sourcify.dev/server/v2/contract/' + chainId + '/' + address);
        value = { ...value, runtimeMatch: typeof matched.runtimeMatch === 'string' ? matched.runtimeMatch : null,
          creationMatch: typeof matched.creationMatch === 'string' ? matched.creationMatch : null };
      } catch { /* A newly indexed deployment can still be pending. */ }
      const source = await etherscan({ action: 'getsourcecode', address });
      const entry = source.status === '1' && Array.isArray(source.result) ? source.result[0] : null;
      value.etherscanVerified = !!entry?.SourceCode && entry.ContractName === artifact.contract;
      value.etherscanMatch = value.etherscanVerified ? entry.SimilarMatch ? 'similar' : 'exact' : null;
      if (!value.etherscanVerified && !value.etherscanGuid && (!value.etherscanAttemptAt || value.etherscanAttemptAt < now() - 60000)) {
        const submission = await etherscan({ action: 'verifysourcecode', contractaddress: address,
          sourceCode: JSON.stringify(artifact.standardInput), codeformat: 'solidity-standard-json-input',
          contractname: artifact.entry + ':' + artifact.contract, compilerversion: 'v' + artifact.profile.compiler.replace('.Emscripten.clang', ''),
          constructorArguments: constructorArguments.slice(2) });
        value.etherscanAttemptAt = now();
        if (submission.status === '1') value.etherscanGuid = submission.result;
        else value.etherscanError = String(submission.result).slice(0, 500);
      }
      if (value.etherscanGuid && !value.etherscanVerified) {
        const status = await etherscan({ action: 'checkverifystatus', guid: value.etherscanGuid });
        if (status.status === '0' && !/pending|queue/i.test(status.result)) value.etherscanError = String(status.result).slice(0, 500);
      }
      value = { ...value, checkedAt: now(), explorerUrl: (chainId === 1 ? 'https://etherscan.io/address/' : 'https://sepolia.etherscan.io/address/') + address + '#code',
        sourcifyUrl: 'https://repo.sourcify.dev/' + chainId + '/' + address };
      if (value.etherscanVerified) delete value.etherscanError;
      if (value.runtimeMatch === 'exact_match' && value.creationMatch === 'exact_match' && value.etherscanVerified) value.state = 'verified';
      await save(); return value;
    }
  };
}
