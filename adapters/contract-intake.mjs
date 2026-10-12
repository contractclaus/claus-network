import { decodeEventLog, encodeFunctionData, hexToBytes, keccak256, parseAbi, stringToHex } from 'viem';
import { canonical, digest, requireThat } from '../src/shared/index.mjs';

export const PROPOSAL_CAPABILITY = keccak256(stringToHex('claus.proposal.create.v1'));
export const inboxAbi = parseAbi([
  'event Requested(bytes32 indexed id,address indexed requester,bytes32 indexed binding,bytes32 capability,uint64 deadline,uint32 callbackGas,bytes input)',
  'function requests(bytes32) view returns(address requester,uint64 deadline,uint32 callbackGas,uint8 state,bool callbackDelivered,bytes32 resultHash,bytes32 evidenceHash)',
  'function dispatcher() view returns(address)',
  'function resolve(bytes32 id,bool success,bytes32 evidenceHash,bytes result)',
  'function deliverCallback(bytes32 id,bytes result) returns(bool)'
]);
const lower = x => typeof x === 'string' ? x.toLowerCase() : '';
const boundedNumber = value => {
  const n = Number(value); requireThat(Number.isSafeInteger(n) && n >= 0, 'invalid_chain_number'); return n;
};

// Read/prepare only. The host must supply a reviewed, constructor-bound inbox
// pin. This adapter does not fund, sign, send, or silently choose another RPC.
export function createContractInboxRead({ client, inbox, codeHash, dispatcher }) {
  for (const value of [inbox, dispatcher]) requireThat(/^0x[0-9a-fA-F]{40}$/.test(value), 'invalid_inbox_pin');
  requireThat(/^0x[0-9a-f]{64}$/.test(codeHash), 'invalid_inbox_pin');
  const profile = { chainId: 11155111, inbox: lower(inbox), codeHash, capability: PROPOSAL_CAPABILITY };
  async function verify(blockNumber) {
    requireThat(await client.getChainId() === profile.chainId, 'wrong_chain');
    const code = await client.getCode({ address: inbox, blockNumber });
    requireThat(code && code !== '0x' && keccak256(code) === codeHash, 'inbox_code_mismatch');
    const actual = await client.readContract({ address: inbox, abi: inboxAbi, functionName: 'dispatcher', blockNumber });
    requireThat(lower(actual) === lower(dispatcher), 'inbox_dispatcher_mismatch');
  }
  async function state(id, blockNumber) {
    return client.readContract({ address: inbox, abi: inboxAbi, functionName: 'requests', args: [id], blockNumber });
  }
  return {
    profile: async () => ({ ...profile }),
    async scan({ afterBlock, blockHash = null, afterLogIndex = null, limit = 500 }) {
      requireThat(Number.isSafeInteger(afterBlock) && afterBlock >= 0 && Number.isSafeInteger(limit) &&
        limit > 0 && limit <= 2000 && (afterLogIndex === null || Number.isSafeInteger(afterLogIndex) && afterLogIndex >= 0), 'invalid_scan_range');
      const finalized = await client.getBlock({ blockTag: 'finalized' });
      await verify(finalized.number);
      if (blockHash) requireThat((await client.getBlock({ blockNumber: BigInt(afterBlock) })).hash === blockHash,
        'inbox_cursor_reorganized');
      if (BigInt(afterBlock) > finalized.number || BigInt(afterBlock) === finalized.number && afterLogIndex === null)
        return { events: [], cursor: { afterBlock, blockHash, ...(afterLogIndex === null ? {} : { afterLogIndex }) } };
      const from = BigInt(afterBlock + (afterLogIndex === null ? 1 : 0));
      let end = finalized.number < from + BigInt(limit - 1) ? finalized.number : from + BigInt(limit - 1);
      let logs;
      // Busy ranges shrink without skipping events. A single busy block uses
      // a log-index cursor, so even a block larger than one page can progress.
      while (true) {
        try {
          logs = await client.getLogs({ address: inbox,
            event: inboxAbi.find(x => x.type === 'event' && x.name === 'Requested'),
            fromBlock: from, toBlock: end, strict: true });
        } catch (error) {
          if (end === from) throw error;
          end = from + (end - from) / 2n; continue;
        }
        if (logs.length <= 5000 || end === from) break;
        end = from + (end - from) / 2n;
      }
      logs.sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
      if (afterLogIndex !== null) logs = logs.filter(log => log.blockNumber > from || log.logIndex > afterLogIndex);
      // Bound work per hosted invocation independently of the RPC range limit.
      const remaining = logs.length > 32;
      if (remaining) logs = logs.slice(0, 32);
      const cursorBlock = remaining ? logs.at(-1).blockNumber : end;
      const block = await client.getBlock({ blockNumber: cursorBlock });
      return { events: logs.map(log => ({ bindingId: 'sha256:' + log.args.binding.slice(2),
        transactionHash: log.transactionHash, logIndex: log.logIndex })),
        cursor: { afterBlock: boundedNumber(cursorBlock), blockHash: block.hash,
          ...(remaining ? { afterLogIndex: logs.at(-1).logIndex } : {}) } };
    },
    async observe(binding, pointer) {
      requireThat(lower(binding.inbox) === profile.inbox && binding.codeHash === codeHash &&
        binding.chainId === profile.chainId && binding.capability === profile.capability, 'inbox_binding_mismatch');
      requireThat(/^0x[0-9a-f]{64}$/.test(pointer.transactionHash) && Number.isSafeInteger(pointer.logIndex) &&
        pointer.logIndex >= 0, 'invalid_event_pointer');
      const receipt = await client.getTransactionReceipt({ hash: pointer.transactionHash });
      const finalized = await client.getBlock({ blockTag: 'finalized' });
      requireThat(receipt.status === 'success' && receipt.blockNumber <= finalized.number &&
        lower(receipt.transactionHash) === pointer.transactionHash, 'inbox_event_not_finalized');
      const canonicalBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
      requireThat(canonicalBlock.hash === receipt.blockHash, 'inbox_event_reorganized');
      await verify(receipt.blockNumber);
      const log = receipt.logs.find(x => x.logIndex === pointer.logIndex);
      requireThat(log && lower(log.address) === profile.inbox && !log.removed &&
        log.blockHash === receipt.blockHash && lower(log.transactionHash) === pointer.transactionHash, 'inbox_event_mismatch');
      const event = decodeEventLog({ abi: inboxAbi, data: log.data, topics: log.topics, strict: true });
      requireThat(event.eventName === 'Requested', 'inbox_event_mismatch');
      const a = event.args, bytes = hexToBytes(a.input);
      requireThat(bytes.length > 0 && bytes.length <= 8192, 'invalid_contract_input');
      let input;
      try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { requireThat(false, 'invalid_contract_input'); }
      // The observation is a stable historical fact. Later cancellation,
      // resolution and expiry are checked at dispatch, not hashed into this
      // event's identity; otherwise a replay after completion could diverge.
      const [requester, deadline, callbackGas, status] = await state(a.id, receipt.blockNumber);
      requireThat(lower(requester) === lower(a.requester) && deadline === a.deadline &&
        callbackGas === a.callbackGas && status === 1, 'inbox_request_closed');
      return { ...profile, finalized: true, state: 'pending', requestId: a.id, requester: lower(a.requester),
        binding: a.binding, deadline: boundedNumber(a.deadline), callbackGas: boundedNumber(a.callbackGas), input,
        blockNumber: boundedNumber(receipt.blockNumber), blockHash: receipt.blockHash,
        transactionHash: pointer.transactionHash, logIndex: pointer.logIndex };
    },
    async pending(binding, observation) {
      requireThat(lower(binding.inbox) === profile.inbox && binding.codeHash === codeHash, 'inbox_binding_mismatch');
      const head = await client.getBlock({ blockTag: 'latest' });
      await verify(head.number);
      const original = await client.getBlock({ blockNumber: BigInt(observation.blockNumber) });
      requireThat(original.hash === observation.blockHash, 'inbox_event_reorganized');
      const [requester, deadline, callbackGas, status] = await state(observation.requestId, head.number);
      return status === 1 && lower(requester) === binding.requester &&
        boundedNumber(deadline) === observation.deadline && boundedNumber(callbackGas) === observation.callbackGas &&
        deadline > head.timestamp;
    },
    async deliveryState(request, blockTag = 'latest') {
      requireThat(['latest', 'finalized'].includes(blockTag), 'invalid_block_tag');
      const { observation, result } = request;
      requireThat(request.state === 'result_ready' && lower(observation.inbox) === profile.inbox &&
        observation.codeHash === codeHash && result?.kind === 'proposal-decision' &&
        ['approve', 'reject'].includes(result.decision) && /^sha256:[0-9a-f]{64}$/.test(result.decisionHash),
      'inbox_result_mismatch');
      const block = await client.getBlock({ blockTag });
      await verify(block.number);
      requireThat((await client.getBlock({ blockNumber: BigInt(observation.blockNumber) })).hash ===
        observation.blockHash, 'inbox_event_reorganized');
      const [requester, deadline, callbackGas, status, callbackDelivered, resultHash, evidenceHash] =
        await state(observation.requestId, block.number);
      requireThat(lower(requester) === observation.requester && boundedNumber(deadline) === observation.deadline &&
        boundedNumber(callbackGas) === observation.callbackGas, 'inbox_request_mismatch');
      const resolved = [2, 3].includes(status);
      if (resolved) requireThat(status === (result.decision === 'approve' ? 2 : 3) &&
        resultHash === keccak256(stringToHex(canonical(result))) &&
        evidenceHash === '0x' + result.decisionHash.slice(7), 'inbox_result_mismatch');
      return { resolved, callbackDelivered, pending: status === 1 && deadline > block.timestamp,
        closed: [4, 5].includes(status) || (status === 1 && deadline <= block.timestamp),
        blockNumber: boundedNumber(block.number), blockHash: block.hash, finalized: blockTag === 'finalized' };
    },
    async resolution(request) {
      requireThat(request.state === 'result_ready' && request.result?.kind === 'proposal-decision' &&
        ['approve', 'reject'].includes(request.result.decision), 'inbox_result_unavailable');
      const { observation, result } = request;
      requireThat(lower(observation.inbox) === profile.inbox && observation.codeHash === codeHash &&
        /^sha256:[0-9a-f]{64}$/.test(result.decisionHash), 'inbox_result_mismatch');
      const resultBytes = stringToHex(canonical(result));
      return { id: digest({ intake: request.id, action: 'resolve' }), chainId: profile.chainId,
        from: dispatcher, to: inbox, value: '0', expiresAt: observation.deadline * 1000,
        data: encodeFunctionData({ abi: inboxAbi, functionName: 'resolve', args: [observation.requestId,
          result.decision === 'approve', '0x' + result.decisionHash.slice(7), resultBytes] }),
        callback: observation.callbackGas === 0 ? null : { to: inbox, value: '0',
          data: encodeFunctionData({ abi: inboxAbi, functionName: 'deliverCallback', args: [observation.requestId, resultBytes] }) } };
    }
  };
}
