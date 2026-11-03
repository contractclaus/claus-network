// Live read of real public accounts. Prints signals and decision; no keys, no writes.
import { viewAccount } from './src/near.js';
import { gatherFacts } from './src/enrich.js';
import { assess } from './src/check.js';
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['wrap.near', 'aurora', 'this-account-should-not-exist-cc-0001.near'];
for (const id of ids) {
  try {
    const rpc = await viewAccount(id);
    const facts = await gatherFacts({ accountId: id, rpc, store: {}, amount: 0.5 });
    const r = assess(facts);
    console.log(JSON.stringify({ id, exists: facts.exists, ageDays: facts.ageDays, txCount: facts.txCount, decision: r.decision, codes: r.reasons.map(x => x.code) }));
  } catch (e) { console.log(JSON.stringify({ id, error: String(e.message || e) })); }
}
