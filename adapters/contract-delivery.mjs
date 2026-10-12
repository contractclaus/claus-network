import { digest, requireThat, shape, integer, amount, text } from '../src/shared/index.mjs';
import { createSepoliaTransactions } from './sepolia-transactions.mjs';

const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value) && !/^0x0{40}$/.test(value);
const BUDGETS = 'contract-dispatch-budgets', RESERVATIONS = 'contract-dispatch-reservations';

// Host-only admission. This is deliberately not an API operation. Installing
// another grant requires the operator's separate financial authorization.
export async function admitContractDispatchBudget(store, config) {
  shape(config, ['id', 'chainId', 'dispatcher', 'inbox', 'codeHash', 'projectIds', 'expiresAt',
    'maximumTotal', 'maximumTransaction', 'maximumGas', 'maximumFeePerGas',
    ...(Object.hasOwn(config, 'maximumProject') ? ['maximumProject'] : []),
    ...(Object.hasOwn(config, 'admissionMode') ? ['admissionMode'] : [])]);
  const publicAdmission = config.admissionMode === 'public-readonly-v1';
  requireThat(!Object.hasOwn(config, 'admissionMode') || publicAdmission, 'invalid_dispatch_budget');
  text(config.id); integer(config.expiresAt, 1);
  requireThat(config.chainId === 11155111 && address(config.dispatcher) && address(config.inbox) &&
    /^0x[0-9a-f]{64}$/.test(config.codeHash) && Array.isArray(config.projectIds) &&
    (publicAdmission ? config.projectIds.length === 0 : config.projectIds.length > 0 && config.projectIds.length <= 100) &&
    new Set(config.projectIds).size === config.projectIds.length, 'invalid_dispatch_budget');
  config.projectIds.forEach(value => text(value));
  const total = amount(config.maximumTotal), perTransaction = amount(config.maximumTransaction);
  if (publicAdmission) requireThat(amount(config.maximumProject) > 0n && amount(config.maximumProject) <= total,
    'invalid_dispatch_budget');
  if (publicAdmission) requireThat(perTransaction <= amount(config.maximumProject), 'invalid_dispatch_budget');
  requireThat(total > 0n && perTransaction > 0n && perTransaction <= total &&
    perTransaction <= 10000000000000000n && amount(config.maximumGas) > 0n &&
    amount(config.maximumGas) <= 30000000n && amount(config.maximumFeePerGas) > 0n &&
    amount(config.maximumFeePerGas) <= 50000000000n, 'invalid_dispatch_budget');
  return store.transaction(async tx => {
    const old = await tx.read(BUDGETS, config.id);
    if (old) { requireThat(old.value.configHash === digest(config), 'idempotency_conflict'); return old.value; }
    const value = { config, configHash: digest(config), reserved: '0', spent: '0', revokedAt: null };
    await tx.write(BUDGETS, config.id, value, 0); return value;
  });
}

export async function revokeContractDispatchBudget(store, id, now = Date.now()) {
  return store.transaction(async tx => {
    const row = await tx.read(BUDGETS, id); requireThat(row, 'dispatch_budget_missing');
    if (row.value.revokedAt) return row.value;
    const value = { ...row.value, revokedAt: now };
    await tx.write(BUDGETS, id, value, row.revision); return value;
  });
}

// One bounded resolve and one bounded callback attempt per request. Unknown
// broadcasts are reconciled by their original hash, including after revocation.
export function createContractDelivery(options) {
  const current = createBoundContractDelivery(options);
  return { async step(input) {
    requireThat(input.id === digest({ requestId: input.request.id, action: 'result-delivery' }), 'dispatch_id_mismatch');
    const original = (await options.store.read('chain-transactions', 'contract-delivery:' + input.id + ':resolve'))?.value;
    const budgetId = original?.intent?.authority?.budgetId;
    if (!budgetId || budgetId === options.budget.id) return current.step(input);
    const prior = (await options.store.read(BUDGETS, budgetId))?.value.config;
    requireThat(prior && prior.chainId === options.budget.chainId && prior.inbox === options.budget.inbox &&
      prior.codeHash === options.budget.codeHash && prior.dispatcher === options.budget.dispatcher,
    'dispatch_budget_mismatch');
    // A newly selected allocation never rewrites a pending transaction's
    // original authority, deadline or spending ledger.
    return createBoundContractDelivery({ ...options, budget: prior }).step(input);
  } };
}

function createBoundContractDelivery({ store, client, signer, sealer, chain, identity, budget,
  admitted = null, now = () => Date.now() }) {
  requireThat(signer.address.toLowerCase() === budget.dispatcher, 'dispatch_signer_mismatch');
  const publicAdmission = budget.admissionMode === 'public-readonly-v1';
  requireThat(!publicAdmission || typeof admitted === 'function', 'dispatch_admission_required');
  const configHash = digest(budget);
  async function budgetRow(reader) {
    const row = await reader.read(BUDGETS, budget.id);
    requireThat(row?.value.configHash === configHash && digest(row.value.config) === configHash,
      'dispatch_budget_mismatch');
    return row;
  }
  async function active(reader, request) {
    const row = await budgetRow(reader);
    if (row.value.revokedAt || budget.expiresAt <= now() ||
      (!publicAdmission && !budget.projectIds.includes(request.projectId))) return false;
    if (admitted && await admitted(reader, request.projectId) !== true) return false;
    const binding = (await reader.read('contract-bindings', request.bindingId))?.value;
    if (!binding || binding.projectId !== request.projectId || binding.revokedAt || binding.expiresAt <= now() ||
      binding.inbox !== budget.inbox || binding.codeHash !== budget.codeHash ||
      binding.requester !== request.observation.requester) return false;
    const original = (await reader.read('contract-requests', request.id))?.value;
    if (!original || original.state !== 'result_ready' || digest(original.result) !== digest(request.result) ||
      original.observationHash !== digest(request.observation)) return false;
    try {
      await identity.authorize(binding.actor, 'contract.request', { projectId: request.projectId }, reader);
      await identity.authorize(binding.actor, 'proposal.create', { projectId: request.projectId }, reader);
    } catch (error) {
      if (error.code === 'scope_denied') return false;
      throw error;
    }
    return true;
  }
  async function reserve(tx, { id, intent, maximum }) {
    const row = await budgetRow(tx), value = row.value;
    requireThat(!value.revokedAt && budget.expiresAt > now(), 'transaction_not_authorized');
    requireThat(!await tx.read(RESERVATIONS, id), 'dispatch_reservation_exists');
    requireThat(amount(maximum) <= amount(budget.maximumTransaction) &&
      amount(value.spent) + amount(value.reserved) + amount(maximum) <= amount(budget.maximumTotal),
    'dispatch_budget_exhausted');
    let projectId;
    if (publicAdmission) {
      const request = (await tx.read('contract-requests', intent.authority.requestId))?.value;
      requireThat(request?.projectId, 'dispatch_request_missing'); projectId = request.projectId;
      const key = digest({ budgetId: budget.id, projectId });
      const row = await tx.read('contract-dispatch-projects', key), used = row?.value ?? { spent: '0', reserved: '0' };
      requireThat(amount(used.spent) + amount(used.reserved) + amount(maximum) <= amount(budget.maximumProject),
        'dispatch_project_budget_exhausted');
      await tx.write('contract-dispatch-projects', key, { ...used, reserved: (amount(used.reserved) + amount(maximum)).toString() }, row?.revision ?? 0);
    }
    await tx.write(BUDGETS, budget.id, { ...value, reserved: (amount(value.reserved) + amount(maximum)).toString() }, row.revision);
    await tx.write(RESERVATIONS, id, { budgetId: budget.id, maximum, state: 'reserved', actual: null,
      ...(projectId ? { projectId } : {}) }, 0);
  }
  async function finalize(tx, { id, state, actual }) {
    const row = await budgetRow(tx), item = await tx.read(RESERVATIONS, id);
    requireThat(item?.value.budgetId === budget.id && item.value.state === 'reserved' &&
      amount(actual) <= amount(item.value.maximum) && amount(row.value.reserved) >= amount(item.value.maximum),
    'dispatch_settlement_mismatch');
    if (item.value.projectId) {
      const key = digest({ budgetId: budget.id, projectId: item.value.projectId });
      const row = await tx.read('contract-dispatch-projects', key);
      requireThat(row && amount(row.value.reserved) >= amount(item.value.maximum), 'dispatch_settlement_mismatch');
      await tx.write('contract-dispatch-projects', key, {
        reserved: (amount(row.value.reserved) - amount(item.value.maximum)).toString(),
        spent: (amount(row.value.spent) + amount(actual)).toString()
      }, row.revision);
    }
    await tx.write(BUDGETS, budget.id, { ...row.value,
      reserved: (amount(row.value.reserved) - amount(item.value.maximum)).toString(),
      spent: (amount(row.value.spent) + amount(actual)).toString() }, row.revision);
    await tx.write(RESERVATIONS, id, { ...item.value, state, actual }, item.revision);
  }
  return { async step({ id, request, allowSubmit }) {
    requireThat(id === digest({ requestId: request.id, action: 'result-delivery' }), 'dispatch_id_mismatch');
    const profile = await chain.profile();
    requireThat(profile.chainId === budget.chainId && profile.inbox === budget.inbox &&
      profile.codeHash === budget.codeHash, 'dispatch_profile_mismatch');
    const resultHash = digest(request.result);
    let resolveTransaction;
    const answer = (state, extra = {}) => ({ state, resultHash,
      ...(resolveTransaction ? { resolutionFinalized: true, transactionHash: resolveTransaction.hash } : {}), ...extra });
    const resolution = await chain.resolution(request);
    requireThat(resolution.chainId === budget.chainId && resolution.from.toLowerCase() === budget.dispatcher &&
      resolution.to.toLowerCase() === budget.inbox && resolution.value === '0', 'dispatch_intent_mismatch');
    for (const action of ['resolve', ...(resolution.callback ? ['callback'] : [])]) {
      const intent = action === 'resolve' ? resolution : resolution.callback;
      requireThat(intent.to.toLowerCase() === budget.inbox && intent.value === '0', 'dispatch_intent_mismatch');
      const transactionId = 'contract-delivery:' + id + ':' + action;
      const expiresAt = action === 'resolve' ? Math.min(resolution.expiresAt, budget.expiresAt) : budget.expiresAt;
      const authority = { kind: 'contract-result', requestId: request.id, resultHash, action, budgetId: budget.id, configHash };
      // RPC calls stay outside the PostgreSQL transaction. The callback below
      // rechecks current database authority, and the inbox enforces chain state.
      const observedForSubmit = await chain.deliveryState(request);
      const transactions = createSepoliaTransactions({ store, client, signer, sealer, now, finalized: true,
        limits: { gas: budget.maximumGas, feePerGas: budget.maximumFeePerGas, cost: budget.maximumTransaction },
        onReserve: reserve, onFinalize: finalize,
        authorize: async (candidate, reader) => {
          requireThat(candidate.to?.toLowerCase() === budget.inbox && candidate.data === intent.data &&
            candidate.value === '0' && candidate.expiresAt === expiresAt &&
            digest(candidate.authority) === digest(authority), 'dispatch_intent_mismatch');
          if (!allowSubmit || !await active(reader, request)) return false;
          const observed = observedForSubmit;
          return action === 'resolve' ? observed.pending : observed.resolved && !observed.callbackDelivered;
        } });
      let transaction = await transactions.status(transactionId);
      if (transaction) requireThat(transaction.intent.to?.toLowerCase() === budget.inbox &&
        transaction.intent.data === intent.data && transaction.intent.value === '0' &&
        transaction.intent.expiresAt === expiresAt && digest(transaction.intent.authority) === digest(authority),
      'dispatch_intent_mismatch');
      if (!transaction) {
        const observed = await chain.deliveryState(request);
        if (action === 'resolve' && observed.closed) return answer('closed');
        // Anyone may deliver the callback. Verify its final state and retain
        // our original resolution receipt, without claiming the external tx.
        if (action === 'callback' && observed.callbackDelivered) {
          const final = await chain.deliveryState(request, 'finalized');
          if (!final.resolved || !final.callbackDelivered) return answer('pending');
          continue;
        }
        // An externally resolved request has no local resolution receipt.
        if (action === 'resolve' && observed.resolved) return answer('pending');
        if (action === 'resolve' && resolution.expiresAt <= now()) return answer('closed');
        if (expiresAt <= now()) return answer('failed', { reason: 'dispatch_subsidy_expired', phase: action });
        if (!allowSubmit || !await active(store, request)) return answer('pending');
        transaction = await transactions.prepare({ id: transactionId, to: intent.to, data: intent.data, authority, expiresAt });
      }
      transaction = await transactions.submit(transactionId);
      if (!['confirmed', 'reverted', 'cancelled'].includes(transaction.state)) transaction = await transactions.reconcile(transactionId);
      if (['cancelled', 'reverted'].includes(transaction.state)) {
        if (action === 'callback') {
          const final = await chain.deliveryState(request, 'finalized');
          if (final.resolved && final.callbackDelivered) continue;
          if ((await chain.deliveryState(request)).callbackDelivered) return answer('pending');
        }
        if (transaction.state === 'cancelled') {
          if (action === 'resolve' && ((await chain.deliveryState(request)).closed || resolution.expiresAt <= now()))
            return answer('closed');
          return answer('failed', { reason: 'dispatch_cancelled', phase: action });
        }
        return answer('failed', { reason: 'dispatch_transaction_reverted', phase: action });
      }
      if (transaction.state !== 'confirmed') return answer('pending');
      const observed = await chain.deliveryState(request, 'finalized');
      if (observed.blockNumber < Number(transaction.receipt.blockNumber)) return answer('pending');
      requireThat(observed.resolved, 'dispatch_result_not_finalized');
      if (action === 'resolve') resolveTransaction = transaction;
      else if (!observed.callbackDelivered) return answer('failed', { reason: 'dispatch_callback_not_delivered', phase: action });
    }
    return answer('delivered', { finalized: true, transactionHash: resolveTransaction.hash });
  } };
}
