// Scoped NEAR function-call access key for the agent.
// The agent never holds a full-access key: this key can only call the listed
// methods on one receiver contract, with a capped gas allowance, and it can
// never attach a deposit (NEAR rejects deposits on function-call keys).
import { KeyPair, transactions, utils } from 'near-api-js';

export function createScopedKey({ receiverId, methodNames = [], allowanceNear = '0.25' }) {
  if (!receiverId) throw new Error('receiverId required');
  const keyPair = KeyPair.fromRandom('ed25519');
  const allowance = BigInt(utils.format.parseNearAmount(allowanceNear));
  const action = transactions.addKey(
    keyPair.getPublicKey(),
    transactions.functionCallAccessKey(receiverId, methodNames, allowance)
  );
  return {
    publicKey: keyPair.getPublicKey().toString(),
    keyPair,
    scope: { receiverId, methodNames, allowanceYocto: allowance.toString() },
    addKeyAction: action, // signed by the owner's full-access key, never by the agent
  };
}

// Local pre-check mirroring the protocol's own function-call-key rules, so the
// wrapper can refuse before anything is signed.
export function keyPermits(scope, { receiverId, methodName, depositYocto = '0' }) {
  if (BigInt(depositYocto) !== 0n) return { ok: false, reason: 'deposit_not_allowed_on_function_call_key' };
  if (receiverId !== scope.receiverId) return { ok: false, reason: 'receiver_out_of_scope' };
  if (scope.methodNames.length && !scope.methodNames.includes(methodName)) return { ok: false, reason: 'method_out_of_scope' };
  return { ok: true };
}
