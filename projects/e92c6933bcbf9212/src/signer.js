// Real offline NEAR signer bound to a scoped function-call access key.
// It builds an actual NEAR Transaction (functionCall action, zero deposit),
// borsh-encodes it, signs sha256(bytes) with the scoped ed25519 key and returns
// a SignedTransaction ready for broadcast_tx_commit. Nonce and recent block hash
// are supplied by the caller (from view_access_key / latest block) so this module
// never needs network access and never sees a full-access key.
import { transactions, utils } from 'near-api-js';
import { createHash } from 'crypto';
import { keyPermits } from './scopedkey.js';

const DEFAULT_GAS = 30_000_000_000_000n; // 30 Tgas

export function nearSigner({ signerId, keyPair, scope }) {
  if (!signerId || !keyPair || !scope) throw new Error('signerId, keyPair and scope required');
  return {
    scope,
    publicKey: keyPair.getPublicKey().toString(),
    sign(action, { nonce, blockHash }) {
      const p = keyPermits(scope, { receiverId: action.receiverId, methodName: action.method, depositYocto: action.depositYocto ?? '0' });
      if (!p.ok) throw new Error(`key_scope: ${p.reason}`);
      if (nonce === undefined || !blockHash) throw new Error('nonce and blockHash required');
      const hashBytes = typeof blockHash === 'string' ? utils.serialize.base_decode(blockHash) : blockHash;
      const fc = transactions.functionCall(action.method, action.args ?? {}, BigInt(action.gas ?? DEFAULT_GAS), 0n);
      const tx = transactions.createTransaction(signerId, keyPair.getPublicKey(), action.receiverId, BigInt(nonce), [fc], hashBytes);
      const bytes = tx.encode();
      const digest = new Uint8Array(createHash('sha256').update(bytes).digest());
      const { signature } = keyPair.sign(digest);
      const signed = new transactions.SignedTransaction({
        transaction: tx,
        signature: new transactions.Signature({ keyType: tx.publicKey.keyType, data: signature }),
      });
      return { signed: true, txHash: utils.serialize.base_encode(digest), signedTx: Buffer.from(signed.encode()).toString('base64'), digest };
    },
  };
}
