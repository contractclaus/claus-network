// Combine RPC facts with indexer age and the local code-hash store into one facts object for assess().
import { accountAgeDays } from './indexer.js';
import { observe } from './codewatch.js';

export async function gatherFacts({ accountId, rpc, store, amount = 0, priorInteractions = false, fetchAge = accountAgeDays }) {
  const age = await fetchAge(accountId);
  const facts = { accountId, exists: rpc.exists, codeHash: rpc.codeHash, ageDays: age.ageDays, amount, priorInteractions };
  if (rpc.exists && rpc.codeHash) {
    const seen = observe(store, accountId, rpc.codeHash);
    // Only a previously recorded hash counts as 'known'; first sight stays unknown.
    if (seen.previous) facts.knownCodeHash = seen.previous;
    facts.codeWatch = seen.change;
  }
  return facts;
}
