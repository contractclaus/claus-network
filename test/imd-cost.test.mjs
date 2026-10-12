import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeEventTopics, encodeAbiParameters, parseAbi } from 'viem';
import { createImdCostVerifier } from '../adapters/imd-cost.mjs';
import { IMD_REVIEW } from '../adapters/imd.mjs';

test('a review charge requires the exact payer, order, canonical receipt and confirmation depth', async () => {
  const payer = '0x' + '11'.repeat(20), txHash = '0x' + '22'.repeat(32), blockHash = '0x' + '33'.repeat(32);
  const offer = { id: 'order-one', provider: 'imd-audit-v1', asset: 'eip155:1/erc20:' + IMD_REVIEW.asset, maximum: '500000000000000000' };
  const state = { payer, outcome: { payment: { paid: true, orderId: offer.id, transactionHash: txHash } } };
  const log = { address: IMD_REVIEW.asset, topics: encodeEventTopics({ abi: parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']), eventName: 'Transfer', args: { from: payer, to: IMD_REVIEW.payTo } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(offer.maximum)]) };
  let head = 102n, canonical = blockHash, logs = [log];
  const client = { getChainId: async () => 1, getTransactionReceipt: async () => ({ status: 'success', transactionHash: txHash, blockNumber: 100n, blockHash, logs }),
    getBlockNumber: async () => head, getBlock: async () => ({ hash: canonical }) };
  const verifier = createImdCostVerifier({ client, payer, readPayment: async () => state });
  const input = { state, offer, inputHash: 'sha256:' + '44'.repeat(32) };
  const receipt = await verifier.receipt(input);
  assert.equal(receipt.actual, offer.maximum); assert.equal(await verifier.verify(receipt, offer), true);
  assert.equal(await verifier.verify({ ...receipt, actual: '0' }, offer), false);
  head = 101n; assert.equal(await verifier.receipt(input), null);
  head = 102n; canonical = '0x' + '55'.repeat(32);
  await assert.rejects(verifier.receipt(input), { code: 'cost_receipt_not_canonical' });
  canonical = blockHash; logs = [];
  await assert.rejects(verifier.receipt(input), { code: 'cost_receipt_mismatch' });
  logs = [log]; state.outcome.payment.orderId = 'another-order';
  await assert.rejects(verifier.receipt(input), { code: 'cost_receipt_mismatch' });
});
