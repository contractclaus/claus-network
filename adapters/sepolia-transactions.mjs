import { keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import { digest, requireThat, text } from '../src/shared/index.mjs';
import { authorityDenied } from './authorization.mjs';

const CHAIN = 11155111;
// Sepolia's Glamsterdam state-creation repricing makes the reviewed executor
// deployment ~19.5M gas. The monetary ceiling remains independent and fixed.
const MAX_GAS = 30000000n;
const MAX_FEE = 50000000000n;
const MAX_COST = 10000000000000000n;
const json = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item));
const view = value => {
  const { sealedRaw, ...publicValue } = value;
  return publicValue;
};

// Only the isolated Sepolia executor receives this key. One unresolved
// transaction retains the wallet slot, including across worker restarts.
export function createSepoliaTransactions({ store, client, signer, sealer,
  authorize = async () => false, confirmations = 3, now = () => Date.now(),
  limits = {}, finalized = false, onReserve = async () => {}, onFinalize = async () => {} }) {
  // A caller can only narrow these host limits. Accounting callbacks run in
  // the same transaction as the wallet slot and signed intent.
  const maxGas = BigInt(limits.gas ?? MAX_GAS);
  const maxFee = BigInt(limits.feePerGas ?? MAX_FEE);
  const maxCost = BigInt(limits.cost ?? MAX_COST);
  requireThat(maxGas > 0n && maxGas <= MAX_GAS && maxFee > 0n && maxFee <= MAX_FEE &&
    maxCost > 0n && maxCost <= MAX_COST, 'invalid_transaction_limits');
  const walletId = CHAIN + ':' + signer.address.toLowerCase();
  async function chain() { requireThat(await client.getChainId() === CHAIN, 'wrong_chain'); }
  async function record(id) {
    const row = await store.read('chain-transactions', text(id));
    requireThat(row && row.value.sender.toLowerCase() === signer.address.toLowerCase(), 'transaction_not_found');
    return row;
  }
  async function release(tx, id, consumedNonce = null) {
    const lock = await tx.read('chain-wallet-slots', walletId);
    requireThat(lock?.value.id === id, 'wallet_slot_mismatch');
    await tx.write('chain-wallet-slots', walletId, { id: null,
      minimumNonce: Math.max(lock.value.minimumNonce ?? 0, consumedNonce === null ? 0 : consumedNonce + 1) }, lock.revision);
  }
  return {
    async prepare({ id, to = null, data, authority, expiresAt }) {
      text(id);
      requireThat((to === null || /^0x[0-9a-fA-F]{40}$/.test(to)) && /^0x(?:[0-9a-fA-F]{2})+$/.test(data) &&
        data.length <= 150000 && Number.isSafeInteger(expiresAt) && expiresAt > now(), 'invalid_transaction');
      const intent = { chainId: CHAIN, to, data, value: '0', authority, expiresAt };
      const intentHash = digest(intent), old = await store.read('chain-transactions', id);
      if (old) { requireThat(old.value.intentHash === intentHash, 'idempotency_conflict'); return view(old.value); }
      await chain();
      const request = { account: signer.address, ...(to ? { to } : {}), data, value: 0n };
      const [estimated, fees, nonce, balance] = await Promise.all([
        client.estimateGas(request), client.estimateFeesPerGas(),
        client.getTransactionCount({ address: signer.address, blockTag: 'pending' }),
        client.getBalance({ address: signer.address })
      ]);
      const gas = estimated * 125n / 100n + 10000n;
      requireThat(gas <= maxGas && fees.maxFeePerGas > 0n && fees.maxFeePerGas <= maxFee &&
        fees.maxPriorityFeePerGas >= 0n && fees.maxPriorityFeePerGas <= fees.maxFeePerGas &&
        gas * fees.maxFeePerGas <= maxCost && gas * fees.maxFeePerGas <= balance, 'transaction_cost_limit');
      return store.transaction(async tx => {
        const existing = await tx.read('chain-transactions', id);
        if (existing) { requireThat(existing.value.intentHash === intentHash, 'idempotency_conflict'); return view(existing.value); }
        requireThat(await authorize(intent, tx) === true && expiresAt > now(), 'transaction_not_authorized');
        const lock = await tx.read('chain-wallet-slots', walletId);
        requireThat(!lock?.value.id, 'wallet_busy');
        const effectiveNonce = Math.max(nonce, lock?.value.minimumNonce ?? 0);
        await onReserve(tx, { id, intent, maximum: (gas * fees.maxFeePerGas).toString() });
        // Signing is local and has no external effect. The bytes and nonce are
        // durably committed before any broadcast is possible.
        const unsigned = { chainId: CHAIN, type: 'eip1559', ...(to ? { to } : {}), data, value: 0n,
          nonce: effectiveNonce, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
        const raw = await signer.signTransaction(unsigned);
        const parsed = parseTransaction(raw), recovered = await recoverTransactionAddress({ serializedTransaction: raw });
        requireThat(recovered.toLowerCase() === signer.address.toLowerCase() && parsed.chainId === CHAIN &&
          parsed.nonce === effectiveNonce && parsed.data === data && (parsed.to?.toLowerCase() ?? null) === (to?.toLowerCase() ?? null) &&
          (parsed.value ?? 0n) === 0n && parsed.gas === gas && parsed.maxFeePerGas === fees.maxFeePerGas &&
          (parsed.maxPriorityFeePerGas ?? 0n) === fees.maxPriorityFeePerGas, 'signed_transaction_mismatch');
        const value = { id, intentHash, intent, sender: signer.address, nonce: effectiveNonce, state: 'prepared', hash: keccak256(raw),
          sealedRaw: sealer.seal(id, { raw }), gas: gas.toString(), maxFeePerGas: fees.maxFeePerGas.toString(), createdAt: now() };
        await tx.write('chain-transactions', id, value, 0);
        await tx.write('chain-wallet-slots', walletId, { id, minimumNonce: lock?.value.minimumNonce ?? 0 }, lock?.revision ?? 0);
        return view(value);
      });
    },
    async submit(id) {
      await chain();
      const value = await store.transaction(async tx => {
        const row = await tx.read('chain-transactions', text(id));
        requireThat(row?.value.sender.toLowerCase() === signer.address.toLowerCase(), 'transaction_not_found');
        if (row.value.state !== 'prepared') return null;
        let allowed = false;
        if (row.value.intent.expiresAt > now()) {
          try { allowed = await authorize(row.value.intent, tx) === true; }
          catch (error) { if (!authorityDenied(error)) throw error; }
        }
        if (!allowed) {
          const { sealedRaw, ...rest } = row.value;
          await onFinalize(tx, { id, state: 'cancelled', actual: '0' });
          await tx.write('chain-transactions', id, { ...rest, state: 'cancelled', completedAt: now() }, row.revision);
          await release(tx, id); return null;
        }
        const next = { ...row.value, state: 'broadcasting', submittedAt: now() };
        await tx.write('chain-transactions', id, next, row.revision); return next;
      });
      if (!value) return view((await record(id)).value);
      const { raw } = sealer.open(id, value.sealedRaw);
      requireThat(keccak256(raw) === value.hash, 'transaction_corrupt');
      let returned;
      try { returned = await client.sendRawTransaction({ serializedTransaction: raw }); } catch { /* Reconcile the same hash. */ }
      await store.transaction(async tx => {
        const row = await tx.read('chain-transactions', id);
        if (row.value.state === 'broadcasting') await tx.write('chain-transactions', id,
          { ...row.value, state: returned === value.hash ? 'submitted' : 'unknown' }, row.revision);
      });
      return view((await record(id)).value);
    },
    async reconcile(id) {
      await chain();
      const row = await record(id), value = row.value;
      if (['confirmed', 'reverted', 'cancelled', 'prepared'].includes(value.state)) return view(value);
      let receipt;
      try { receipt = await client.getTransactionReceipt({ hash: value.hash }); } catch { return view(value); }
      const [head, block, sent] = await Promise.all([client.getBlockNumber(),
        client.getBlock({ blockNumber: receipt.blockNumber }), client.getTransaction({ hash: value.hash })]);
      if (head - receipt.blockNumber + 1n < BigInt(confirmations)) return view(value);
      if (finalized && (await client.getBlock({ blockTag: 'finalized' })).number < receipt.blockNumber) return view(value);
      requireThat(block.hash === receipt.blockHash && receipt.transactionHash === value.hash &&
        sent.from.toLowerCase() === signer.address.toLowerCase() && sent.nonce === value.nonce &&
        (sent.to?.toLowerCase() ?? null) === (value.intent.to?.toLowerCase() ?? null) &&
        sent.input === value.intent.data && sent.value === 0n, 'transaction_receipt_mismatch');
      return store.transaction(async tx => {
        const current = await tx.read('chain-transactions', id);
        if (['confirmed', 'reverted'].includes(current.value.state)) return view(current.value);
        const { sealedRaw, ...rest } = current.value;
        const next = { ...rest, state: receipt.status === 'success' ? 'confirmed' : 'reverted', completedAt: now(),
          receipt: json({ transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
            contractAddress: receipt.contractAddress, status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice }) };
        requireThat(receipt.gasUsed <= BigInt(current.value.gas) &&
          receipt.effectiveGasPrice <= BigInt(current.value.maxFeePerGas), 'transaction_cost_mismatch');
        await onFinalize(tx, { id, state: next.state,
          actual: (receipt.gasUsed * receipt.effectiveGasPrice).toString() });
        await tx.write('chain-transactions', id, next, current.revision); await release(tx, id, value.nonce);
        await tx.event({ type: 'chain.transaction_' + next.state, id, hash: next.hash, chainId: CHAIN, at: now() });
        return view(next);
      });
    },
    async status(id) { const row = await store.read('chain-transactions', text(id)); return row ? view(row.value) : null; }
  };
}
