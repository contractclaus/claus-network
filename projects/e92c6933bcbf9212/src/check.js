// Pure policy: facts in, decision + reasons out. No network, no keys.
const RANK = { info: -1, allow: 0, warn: 1, block: 2 };
export const NO_CODE = '11111111111111111111111111111111';
// Well-known mainnet contracts. A listed account still gets code-change protection
// (knownCodeHash pinning); the list only suppresses the first-sight unknown_contract warning.
export const KNOWN_CONTRACTS = new Set(['wrap.near', 'usdt.tether-token.near', 'v2.ref-finance.near', 'aurora', 'relay.aurora', 'social.near']);

export function assess(facts, opts = {}) {
  const minAgeDays = opts.minAgeDays ?? 7;
  const establishedAgeDays = opts.establishedAgeDays ?? 365;
  const maxUnknownPayment = opts.maxUnknownPayment ?? 1; // NEAR
  const known = opts.knownContracts ?? KNOWN_CONTRACTS;
  const reasons = [];
  let decision = 'allow';
  const add = (level, code, detail) => {
    reasons.push({ level, code, detail });
    if (RANK[level] > RANK[decision]) decision = level;
  };
  if (facts.blocklisted) add('block', 'shared_blocklist', `listed with evidence: ${facts.blocklisted.evidence}`);
  if (facts.exists === false) add('block', 'account_missing', 'receiver account does not exist');
  if (facts.knownCodeHash && facts.codeHash && facts.codeHash !== facts.knownCodeHash)
    add('block', 'code_changed', `contract code hash changed since last interaction (${facts.knownCodeHash.slice(0, 8)} -> ${facts.codeHash.slice(0, 8)})`);
  if (facts.ageDays == null) add('info', 'age_unknown', 'account age unavailable (indexer miss); not treated as new');
  else if (facts.ageDays < minAgeDays) add('warn', 'young_account', `account is ${facts.ageDays} days old (< ${minAgeDays})`);
  const thinTx = opts.thinTxCount ?? 5;
  if (facts.exists !== false) {
    if (facts.txCount == null) add('info', 'activity_unknown', 'transaction count unavailable (indexer miss); not treated as inactive');
    else if (facts.txCount === 0) add('warn', 'no_history', 'receiver has no recorded transactions');
    else if (facts.txCount < thinTx) add('info', 'thin_history', `receiver has only ${facts.txCount} recorded transactions`);
  }
  if (!facts.priorInteractions) {
    const amount = facts.amount ?? 0;
    const established = facts.ageDays != null && facts.ageDays >= establishedAgeDays;
    if (established && amount <= maxUnknownPayment)
      add('info', 'first_contact', `first payment, but account is ${facts.ageDays} days old and amount is small`);
    else add('warn', 'first_contact', 'no prior payments from this agent');
    if (amount > maxUnknownPayment)
      add('block', 'large_first_payment', `${amount} NEAR to a first-contact receiver exceeds ${maxUnknownPayment}`);
  }
  if (facts.codeHash && facts.codeHash !== NO_CODE && !facts.knownCodeHash) {
    if (known.has(facts.accountId)) add('info', 'known_contract', `${facts.accountId} is on the known-contract list; code hash pinned from now on`);
    else add('warn', 'unknown_contract', 'receiver is a contract with no recorded code hash');
  }
  return { decision, reasons };
}
