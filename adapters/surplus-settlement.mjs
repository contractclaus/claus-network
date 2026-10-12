// Read-only verifier adapted from the existing Claus payment service.
// It does not authenticate a provider request, issue a signature or enable inference.
import { decodeEventLog, decodeFunctionData, encodeFunctionData, keccak256, parseAbi } from 'viem';
import { eip3009ABI, PERMIT2_ADDRESS, x402UptoPermit2ProxyAddress, x402UptoPermit2ProxyABI } from '@x402/evm';
import { USDC as usdc } from './surplus-x402.mjs';

const network = 'eip155:8453';
const exactAbi = [...eip3009ABI, ...eip3009ABI.filter(x => x.name === 'transferWithAuthorization').map(x => ({ ...x, name: 'receiveWithAuthorization' }))];
const events = parseAbi([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
  'event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)',
  'event AuthorizationCanceled(address indexed authorizer,bytes32 indexed nonce)',
]);
const transferTopic = keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'));
const eventShapes = { Transfer: [3, 66], Approval: [3, 66], AuthorizationUsed: [3, 2], AuthorizationCanceled: [3, 2], Settled: [1, 2], SettledWithPermit: [1, 2] };
const nonceAbi = parseAbi(['function nonceBitmap(address,uint256) view returns (uint256)']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const hex = (v, bytes) => typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v);
const account = v => hex(v, 20) && BigInt(v) !== 0n;
const uint = v => (typeof v === 'string' || typeof v === 'bigint') && /^\d{1,78}$/.test(String(v)) && BigInt(v) < 2n ** 256n;
const signature = v => typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2}){1,4096}$/.test(v);
const blockValid = b => b && typeof b.number === 'bigint' && b.number >= 0n && hex(b.hash, 32) && typeof b.timestamp === 'bigint' && b.timestamp >= 0n;

function authorization(payment, expectedPayer) {
  const q = payment?.accepted, p = payment?.payload;
  if (!account(expectedPayer) || payment?.x402Version !== 2 || !q || q.network !== network || !same(q.asset, usdc)
    || !account(q.payTo) || !uint(q.amount) || BigInt(q.amount) === 0n || !signature(p?.signature)) return null;
  if (q.scheme === 'exact') {
    const a = p.authorization;
    if (!a || !same(a.from, expectedPayer) || !same(a.to, q.payTo) || !hex(a.nonce, 32)
      || ![a.value, a.validAfter, a.validBefore].every(uint) || BigInt(a.value) !== BigInt(q.amount)
      || BigInt(a.validAfter) >= BigInt(a.validBefore) || (q.extra?.assetTransferMethod && q.extra.assetTransferMethod !== 'eip3009')) return null;
    return { a: { from: a.from, to: a.to, value: a.value, nonce: a.nonce, validAfter: a.validAfter, validBefore: a.validBefore },
      q: { scheme: q.scheme, payTo: q.payTo }, p: { signature: p.signature },
      maximum: BigInt(a.value), start: BigInt(a.validAfter), end: BigInt(a.validBefore) };
  }
  if (q.scheme === 'upto') {
    const a = p.permit2Authorization;
    if (!a || !same(a.from, expectedPayer) || !same(a.permitted?.token, usdc) || !same(a.spender, x402UptoPermit2ProxyAddress)
      || ![a.permitted.amount, a.nonce, a.deadline, a.witness?.validAfter].every(uint)
      || BigInt(a.permitted.amount) !== BigInt(q.amount) || !same(a.witness.to, q.payTo)
      || !account(a.witness.facilitator) || !same(a.witness.facilitator, q.extra?.facilitatorAddress)
      || BigInt(a.witness.validAfter) >= BigInt(a.deadline) || (q.extra?.assetTransferMethod && q.extra.assetTransferMethod !== 'permit2')) return null;
    return { a: { from: a.from, spender: a.spender, nonce: a.nonce, deadline: a.deadline,
      permitted: { token: a.permitted.token, amount: a.permitted.amount },
      witness: { to: a.witness.to, facilitator: a.witness.facilitator, validAfter: a.witness.validAfter } },
      q: { scheme: q.scheme, payTo: q.payTo }, p: { signature: p.signature },
      maximum: BigInt(a.permitted.amount), start: BigInt(a.witness.validAfter), end: BigInt(a.deadline) };
  }
  return null;
}

function settlementCall(auth, tx) {
  const { a, q, p, maximum } = auth;
  const abi = q.scheme === 'exact' ? exactAbi : x402UptoPermit2ProxyABI;
  if (!same(tx.to, q.scheme === 'exact' ? usdc : x402UptoPermit2ProxyAddress)
    || typeof tx.input !== 'string' || tx.input.length > 32768 || !/^0x(?:[0-9a-fA-F]{2})+$/.test(tx.input)) return null;
  const call = decodeFunctionData({ abi, data: tx.input });
  // Reject wrappers, batches and noncanonical/trailing calldata conservatively.
  if (!same(encodeFunctionData({ abi, functionName: call.functionName, args: call.args }), tx.input)) return null;
  if (q.scheme === 'exact') {
    if (!['transferWithAuthorization', 'receiveWithAuthorization'].includes(call.functionName)) return null;
    if (call.functionName === 'receiveWithAuthorization' && !same(tx.from, a.to)) return null;
    const [from, to, value, after, before, nonce, ...sig] = call.args;
    const supplied = sig.length === 1 ? sig[0] : `${sig[1]}${sig[2].slice(2)}${Number(sig[0]).toString(16).padStart(2, '0')}`;
    if (!same(from, a.from) || !same(to, a.to) || value !== maximum || after !== BigInt(a.validAfter)
      || before !== BigInt(a.validBefore) || !same(nonce, a.nonce) || !same(supplied, p.signature)) return null;
    return { amount: value, eventName: 'AuthorizationUsed' };
  }
  if (!['settle', 'settleWithPermit'].includes(call.functionName) || !same(tx.from, a.witness.facilitator)) return null;
  const [permit, amount, owner, witness, sig] = call.args.slice(call.functionName === 'settleWithPermit' ? 1 : 0);
  if (!same(owner, a.from) || !same(permit.permitted.token, usdc) || permit.permitted.amount !== maximum
    || permit.nonce !== BigInt(a.nonce) || permit.deadline !== BigInt(a.deadline) || !same(witness.to, a.witness.to)
    || !same(witness.facilitator, a.witness.facilitator) || witness.validAfter !== BigInt(a.witness.validAfter)
    || !same(sig, p.signature) || amount > maximum) return null;
  return { amount, eventName: call.functionName === 'settle' ? 'Settled' : 'SettledWithPermit' };
}

function settlementLogs(auth, mined, amount, eventName) {
  if (!Array.isArray(mined.logs) || mined.logs.length === 0 || mined.logs.length > 64) return false;
  const transfers = [], used = [], settled = [], indices = new Set();
  for (const log of mined.logs) {
    if (!log || log.removed !== false || !same(log.transactionHash, mined.transactionHash) || !same(log.blockHash, mined.blockHash)
      || log.blockNumber !== mined.blockNumber || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || indices.has(log.logIndex)
      || !hex(log.address, 20) || !Array.isArray(log.topics) || log.topics.length > 4 || !log.topics.every(t => hex(t, 32))
      || typeof log.data !== 'string' || log.data.length > 32768 || !/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data)) return false;
    indices.add(log.logIndex);
    let decoded;
    try { decoded = decodeEventLog({ abi: [...events, ...x402UptoPermit2ProxyABI], data: log.data, topics: log.topics, strict: true }); }
    catch { if (same(log.address, usdc) || same(log.address, x402UptoPermit2ProxyAddress)
      || same(log.topics[0], transferTopic)) return false; else continue; }
    const shape = eventShapes[decoded.eventName];
    if (shape && (log.topics.length !== shape[0] || log.data.length !== shape[1])) return false;
    if (decoded.eventName === 'Transfer') transfers.push({ ...decoded, address: log.address });
    if (same(log.address, usdc) && decoded.eventName === 'AuthorizationUsed') used.push(decoded);
    if (same(log.address, usdc) && decoded.eventName === 'AuthorizationCanceled') return false;
    if (same(log.address, x402UptoPermit2ProxyAddress) && ['Settled', 'SettledWithPermit'].includes(decoded.eventName)) settled.push(decoded);
  }
  if (transfers.length !== 1 || !same(transfers[0].address, usdc) || !same(transfers[0].args.from, auth.a.from)
    || !same(transfers[0].args.to, auth.q.payTo) || transfers[0].args.value !== amount) return false;
  if (auth.q.scheme === 'exact') return settled.length === 0 && used.length === 1
    && same(used[0].args.authorizer, auth.a.from) && same(used[0].args.nonce, auth.a.nonce);
  return used.length === 0 && settled.length === 1 && settled[0].eventName === eventName;
}

/**
 * receipt is the decoded x402 payment-response {success, network, payer, transaction}.
 * chain is an injected viem-compatible read-only Base client; no default RPC or signer.
 * Returns {amount: decimal micro-USDC string, proof}, or null (retain reservation).
 * At most eight RPC calls, one transaction, 64 logs, no event scans or retries.
 * Caller must separately validate successful Responses/images delivery. Telemetry is ignored.
 */
export async function verifySettlementCost(payment, receipt, chain, expectedPayer) {
  try {
    const auth = authorization(payment, expectedPayer);
    if (!auth || receipt?.success !== true || receipt.network !== network || !same(receipt.payer, expectedPayer)
      || !hex(receipt.transaction, 32) || !chain) return null;
    // Bind inputs before the first await; concurrent caller edits cannot replace
    // the original authorization, signature, recipient or claimed transaction.
    const transaction = receipt.transaction;
    if (await chain.getChainId() !== 8453) return null;
    const safe = await chain.getBlock({ blockTag: 'safe' });
    if (!blockValid(safe)) return null;
    const mined = await chain.getTransactionReceipt({ hash: transaction });
    if (!mined || mined.status !== 'success' || !same(mined.transactionHash, transaction) || !hex(mined.blockHash, 32)
      || typeof mined.blockNumber !== 'bigint' || mined.blockNumber < 0n || mined.blockNumber > safe.number) return null;
    const tx = await chain.getTransaction({ hash: transaction });
    if (!tx || !same(tx.hash, transaction) || !same(tx.blockHash, mined.blockHash) || tx.blockNumber !== mined.blockNumber
      || !account(tx.from) || !same(tx.from, mined.from) || !same(tx.to, mined.to) || tx.value !== 0n
      || (tx.chainId !== undefined && tx.chainId !== 8453)) return null;
    const canonical = await chain.getBlock({ blockNumber: mined.blockNumber });
    if (!blockValid(canonical) || canonical.number !== mined.blockNumber || !same(canonical.hash, mined.blockHash)
      || canonical.timestamp > safe.timestamp || canonical.timestamp < auth.start || canonical.timestamp > auth.end
      || (auth.q.scheme === 'exact' && (canonical.timestamp === auth.start || canonical.timestamp === auth.end))) return null;
    const call = settlementCall(auth, tx);
    if (!call || !settlementLogs(auth, mined, call.amount, call.eventName)) return null;
    const { amount } = call;
    const used = auth.q.scheme === 'exact'
      ? await chain.readContract({ address: usdc, abi: eip3009ABI, functionName: 'authorizationState', args: [auth.a.from, auth.a.nonce], blockNumber: safe.number })
      : await chain.readContract({ address: PERMIT2_ADDRESS, abi: nonceAbi, functionName: 'nonceBitmap', args: [auth.a.from, BigInt(auth.a.nonce) >> 8n], blockNumber: safe.number });
    if (auth.q.scheme === 'exact' ? used !== true : !uint(used) || (BigInt(used) & (1n << (BigInt(auth.a.nonce) & 255n))) === 0n) return null;
    // Recheck both canonical inclusion and the safe anchor after reading evidence.
    const inclusion = await chain.getBlock({ blockNumber: mined.blockNumber });
    if (!blockValid(inclusion) || inclusion.number !== canonical.number || !same(inclusion.hash, canonical.hash) || inclusion.timestamp !== canonical.timestamp) return null;
    const anchor = await chain.getBlock({ blockNumber: safe.number });
    if (!blockValid(anchor) || anchor.number !== safe.number || !same(anchor.hash, safe.hash) || anchor.timestamp !== safe.timestamp) return null;
    return { amount: String(amount), proof: {
      network, scheme: auth.q.scheme, confirmation: 'safe', asset: usdc, payer: auth.a.from, payTo: auth.q.payTo,
      authorizedMicroUsdc: String(auth.maximum), nonce: String(auth.a.nonce), signatureHash: keccak256(auth.p.signature),
      transaction, transactionBlockNumber: String(mined.blockNumber), transactionBlockHash: mined.blockHash,
      blockNumber: String(safe.number), blockHash: safe.hash, blockTimestamp: String(safe.timestamp),
    } };
  } catch { return null; }
}
