// Pure policy: facts in, decision + reasons out. No network, no keys.
const RANK = { info: -1, allow: 0, warn: 1, block: 2 };
export const NO_CODE = '11111111111111111111111111111111';

export function assess(facts, opts = {}) {
  const minAgeDays = opts.minAgeDays ?? 7;
  const maxUnknownPayment = opts.maxUnknownPayment ?? 1; // NEAR
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
  if (!facts.priorInteractions) {
    add('warn', 'first_contact', 'no prior payments from this agent');
    if ((facts.amount ?? 0) > maxUnknownPayment)
      add('block', 'large_first_payment', `${facts.amount} NEAR to a first-contact receiver exceeds ${maxUnknownPayment}`);
  }
  if (facts.codeHash && facts.codeHash !== NO_CODE && !facts.knownCodeHash)
    add('warn', 'unknown_contract', 'receiver is a contract with no recorded code hash');
  return { decision, reasons };
}
