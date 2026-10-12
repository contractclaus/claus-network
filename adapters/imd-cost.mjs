import { decodeEventLog, parseAbi } from 'viem';
import { IMD_REVIEW } from './imd.mjs';
import { canonical as encode, requireThat } from '../src/shared/index.mjs';

const transfers = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);

// Provider admission binds the order; the chain proves the corresponding
// transfer. Reusing the same transaction for a second job is rejected by the
// billing receipt ledger. Refunds require their own independently checked proof.
export function createImdCostVerifier({ client, payer, confirmations = 3, readPayment }) {
  async function receipt({ state, offer, inputHash }) {
    const observed = state.outcome?.payment;
    if (!observed?.paid || !observed.transactionHash) return null;
    requireThat(observed.orderId === offer.id && state.payer.toLowerCase() === payer.toLowerCase(), 'cost_receipt_mismatch');
    requireThat(await client.getChainId() === 1, 'wrong_chain');
    const chain = await client.getTransactionReceipt({ hash: observed.transactionHash });
    const head = await client.getBlockNumber();
    if (head - chain.blockNumber + 1n < BigInt(confirmations)) return null;
    const canonical = await client.getBlock({ blockNumber: chain.blockNumber });
    requireThat(canonical.hash === chain.blockHash && chain.status === 'success', 'cost_receipt_not_canonical');
    let paid = 0n;
    for (const log of chain.logs) {
      if (log.address.toLowerCase() !== IMD_REVIEW.asset) continue;
      try {
        const event = decodeEventLog({ abi: transfers, topics: log.topics, data: log.data });
        if (event.args.from.toLowerCase() === payer.toLowerCase() && event.args.to.toLowerCase() === IMD_REVIEW.payTo) paid += event.args.value;
      } catch { /* Unrelated token events do not prove payment. */ }
    }
    requireThat(paid === BigInt(offer.maximum), 'cost_receipt_mismatch');
    return { id: 'eip155:1/tx:' + chain.transactionHash.toLowerCase(), provider: offer.provider,
      providerQuoteId: offer.id, inputHash, asset: offer.asset, actual: paid.toString() };
  }
  return { receipt, async verify(evidence, offer) {
    requireThat(typeof readPayment === 'function', 'payment_reader_required');
    const confirmed = await receipt({ state: await readPayment(offer.id), offer, inputHash: evidence.inputHash });
    return confirmed !== null && encode(confirmed) === encode(evidence);
  } };
}
