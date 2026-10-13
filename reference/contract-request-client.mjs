import { decodeEventLog, encodeFunctionData, keccak256, parseAbi, stringToHex } from 'viem';
import { canonical, digest, requireThat, shape } from '../src/shared/index.mjs';

export const requesterAbi = parseAbi([
  'function inbox() view returns (address)',
  'function controller() view returns (address)',
  'function CALLBACK_GAS() view returns (uint32)',
  'function submit(bytes32 binding,bytes32 capability,uint64 deadline,bytes input) returns (bytes32)'
]);
const requestedAbi = parseAbi([
  'event Requested(bytes32 indexed id,address indexed requester,bytes32 indexed binding,bytes32 capability,uint64 deadline,uint32 callbackGas,bytes input)'
]);
const capability = keccak256(stringToHex('claus.proposal.create.v1'));
const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// An admitted project supplies its own previously verified deployment pins.
// This helper reads and simulates only. Signing and durable transaction-hash
// storage remain with the caller's existing wallet tooling.
export async function prepareContractRequest({ api, chain, projectId, bindingId, pin, input, deadline, now = Date.now() }) {
  shape(input, ['moduleId', 'configuration']);
  requireThat(typeof input.moduleId === 'string' && input.moduleId.length > 0 &&
    typeof input.configuration === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(input.configuration), 'invalid_contract_input');
  const encodedInput = stringToHex(canonical(input));
  requireThat((encodedInput.length - 2) / 2 <= 8192, 'invalid_contract_input');
  const binding = await api.call('contract_binding_get', { projectId, bindingId });
  requireThat(binding.id === bindingId && binding.projectId === projectId &&
    bindingId.startsWith('sha256:') && binding.onchainBinding === '0x' + bindingId.slice(7) &&
    /^0x[0-9a-f]{64}$/.test(binding.onchainBinding), 'binding_mismatch');
  requireThat(!binding.revokedAt && binding.expiresAt > now && binding.used < binding.maxRequests, 'binding_inactive');
  requireThat([1,11155111].includes(pin.chainId) && binding.chainId === pin.chainId &&
    sameAddress(binding.inbox, pin.inbox) && binding.codeHash === pin.codeHash &&
    sameAddress(binding.requester, pin.requester) && binding.capability === capability, 'deployment_pin_mismatch');
  requireThat(Number.isSafeInteger(deadline) && deadline * 1000 > now && deadline * 1000 <= binding.expiresAt &&
    deadline * 1000 <= now + 30 * 86400000, 'invalid_request_deadline');
  requireThat(await chain.getChainId() === pin.chainId, 'wrong_chain');
  const finalized = await chain.getBlock({ blockTag: 'finalized' });
  for (const [address, hash] of [[pin.inbox, pin.codeHash], [pin.requester, pin.requesterCodeHash]]) {
    const code = await chain.getCode({ address, blockNumber: finalized.number });
    requireThat(code && code !== '0x' && keccak256(code) === hash, 'deployment_code_mismatch');
  }
  const read = functionName => chain.readContract({ address: pin.requester, abi: requesterAbi, functionName, blockNumber: finalized.number });
  requireThat(sameAddress(await read('inbox'), pin.inbox) && sameAddress(await read('controller'), pin.controller), 'requester_authority_mismatch');
  const callbackGas = Number(await read('CALLBACK_GAS'));
  requireThat(callbackGas === 1000000, 'unsupported_requester_callback');
  const args = [binding.onchainBinding, capability, BigInt(deadline), encodedInput];
  await chain.simulateContract({ account: pin.controller, address: pin.requester, abi: requesterAbi, functionName: 'submit', args });
  return { projectId, bindingId, pin: structuredClone(pin), inputHash: digest(input), deadline, callbackGas,
    transaction: { chainId: pin.chainId, from: pin.controller, to: pin.requester,
      data: encodeFunctionData({ abi: requesterAbi, functionName: 'submit', args }), value: '0' } };
}

// Call with the original transaction hash, including after a timeout. A receipt
// lookup never submits a replacement. An indexed decision is read separately
// through contract_request_get and does not imply upgrade execution.
export async function locateContractRequest({ chain, prepared, transactionHash }) {
  requireThat(await chain.getChainId() === prepared.pin.chainId, 'wrong_chain');
  const receipt = await chain.getTransactionReceipt({ hash: transactionHash });
  requireThat(receipt.status === 'success' && receipt.transactionHash === transactionHash, 'request_transaction_failed');
  const canonicalBlock = await chain.getBlock({ blockNumber: receipt.blockNumber });
  requireThat(canonicalBlock.hash === receipt.blockHash, 'request_reorganized');
  const code = await chain.getCode({ address: prepared.pin.inbox, blockNumber: receipt.blockNumber });
  requireThat(code && keccak256(code) === prepared.pin.codeHash, 'deployment_code_mismatch');
  const events = [];
  for (const log of receipt.logs) {
    if (!sameAddress(log.address, prepared.pin.inbox) || log.removed) continue;
    let event;
    try { event = decodeEventLog({ abi: requestedAbi, data: log.data, topics: log.topics, strict: true }); }
    catch { continue; }
    const a = event.args;
    if (!sameAddress(a.requester, prepared.pin.requester) || a.binding !== '0x' + prepared.bindingId.slice(7)) continue;
    // Earlier saved preparations used the immutable 200k callback client.
    // Keep their receipts readable; fresh preparations pin the new budget.
    requireThat(a.capability === capability && Number(a.deadline) === prepared.deadline &&
      a.callbackGas === (prepared.callbackGas ?? 200000), 'request_event_mismatch');
    const bytes = Buffer.from(a.input.slice(2), 'hex');
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    requireThat(digest(input) === prepared.inputHash, 'request_event_mismatch');
    events.push(a);
  }
  requireThat(events.length === 1, 'request_event_mismatch');
  const finalized = await chain.getBlock({ blockTag: 'finalized' });
  return { projectId: prepared.projectId,
    requestId: digest({ chainId: prepared.pin.chainId, inbox: prepared.pin.inbox.toLowerCase(), requestId: events[0].id }),
    onchainRequestId: events[0].id, transactionHash, finalized: finalized.number >= receipt.blockNumber };
}
