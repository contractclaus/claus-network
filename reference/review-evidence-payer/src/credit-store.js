import {refreshCapitalCash} from './capital/budget.js';
// Trusted adapter accounting only. This store never funds an account, accepts
// credentials, or treats provider/model response text as spending evidence.
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value);
const validAddress = value => typeof value === 'string' && /^0x[\da-fA-F]{40}$/.test(value);
const validTransaction = value => typeof value === 'string' && /^0x[\da-fA-F]{64}$/.test(value);
function integer(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  return ['string', 'number', 'bigint'].includes(typeof value) && /^\d{1,18}$/.test(String(value)) ? BigInt(value) : null;
}

// Constant SQL, shared with setupBudget so DDL and its lifetime invariant are
// checked in the same transaction. Never interpolate caller data into DDL.
export const creditStoreDDL = `
  CREATE TABLE IF NOT EXISTS claus_credit_pool (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    allocated bigint NOT NULL DEFAULT 2000000 CHECK (allocated = 2000000),
    committed bigint NOT NULL DEFAULT 0 CHECK (committed BETWEEN 0 AND allocated),
    state text NOT NULL CHECK (state IN ('prepared', 'funded', 'frozen')),
    deposit_address text NOT NULL, key_id text NOT NULL, deposit_tx text
  );
  CREATE TABLE IF NOT EXISTS claus_credit_requests (
    id text PRIMARY KEY, request_hash text NOT NULL,
    reserved_max bigint NOT NULL CHECK (reserved_max BETWEEN 1 AND 2000000),
    status text NOT NULL CHECK (status IN ('reserved', 'submitting', 'completed', 'failed', 'uncertain')),
    response jsonb, outcome jsonb, binding jsonb NOT NULL, payload_hash text, dispatched_at timestamptz, provider_request_id text, http_status integer,
    accounted_cost bigint CHECK (accounted_cost BETWEEN 0 AND reserved_max),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (accounted_cost IS NULL OR status IN ('completed', 'failed', 'uncertain'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS claus_credit_one_unresolved
    ON claus_credit_requests ((true)) WHERE accounted_cost IS NULL;
`;

/** DDL only: no allocation, funding, reset, or repair. */
export async function setupCreditStore(db) {
  const sql = `DO $$ BEGIN ${creditStoreDDL} END $$`;
  await db(Object.assign([sql], {raw: [sql]}));
}

export async function creditSnapshot(db) {
  const rows = await db`SELECT allocated::text, committed::text,
    (allocated - committed)::text AS remaining, state, deposit_address, key_id, deposit_tx
    FROM claus_credit_pool WHERE id = true`;
  return rows[0] ?? null;
}

/** Allocate exactly once from the existing lifetime budget, before funding. */
export async function allocateCredit(db, {address, keyId} = {}) {
  if (!validAddress(address) || !validId(keyId)) throw Error('invalid_credit_binding');
  try {
    await db`WITH allocated AS (
      UPDATE claus_payment_budget SET committed = committed + 2000000
      WHERE id = true AND (ceiling IN (100000000,500000000) OR ceiling BETWEEN 600000000 AND 1200000000) AND committed BETWEEN 0 AND ceiling - 2000000
        AND NOT EXISTS (SELECT 1 FROM claus_credit_pool)
      RETURNING id
    ) INSERT INTO claus_credit_pool(id, allocated, committed, state, deposit_address, key_id)
      SELECT true, 2000000, 0, 'prepared', ${address}, ${keyId} FROM allocated`;
  } catch (error) {
    // Concurrent allocation loses the singleton INSERT and rolls back its
    // budget UPDATE. Only that conflict can become an exact-binding retry.
    if (error.code !== '23505' || error.constraint !== 'claus_credit_pool_pkey') throw error;
  }
  const pool = await creditSnapshot(db);
  if (!pool) throw Error('credit_allocation_unavailable');
  if (pool.deposit_address !== address || pool.key_id !== keyId) throw Error('credit_binding_conflict');
  return pool;
}

export async function activateCredit(db, {address, keyId, transaction} = {}) {
  if (!validAddress(address) || !validId(keyId) || !validTransaction(transaction)) throw Error('invalid_credit_activation');
  await db`UPDATE claus_credit_pool SET state = 'funded', deposit_tx = ${transaction}
    WHERE id = true AND state = 'prepared' AND deposit_tx IS NULL
      AND deposit_address = ${address} AND key_id = ${keyId}`;
  const pool = await creditSnapshot(db);
  if (!pool || pool.deposit_address !== address || pool.key_id !== keyId) throw Error('credit_binding_conflict');
  if (pool.deposit_tx !== transaction || pool.state !== 'funded') throw Error('credit_activation_conflict');
  return pool;
}

export async function reserveCredit(db, {id, hash, maximum, activeMs} = {}) {
  const amount = integer(maximum);
  if (!validId(id) || typeof hash !== 'string' || !hash.length || hash.length > 128 || hash.includes('\0')
    || amount === null || amount < 1n || amount > 2000000n
    || !Number.isSafeInteger(activeMs) || activeMs < 1 || activeMs > 800000) throw Error('invalid_credit_reservation');
  // The pool UPDATE locks admission. The partial unique index also fences a
  // concurrent statement whose READ COMMITTED snapshot predates that lock.
  // Any duplicate must abort the entire statement, including both writes.
  await refreshCapitalCash(db);
  return db`WITH admitted AS (
    UPDATE claus_credit_pool SET committed = committed + ${String(amount)}::bigint
    WHERE id = true AND state = 'funded' AND allocated = 2000000
      AND committed >= 0 AND allocated - committed = ${String(amount)}::bigint
      AND NOT EXISTS (SELECT 1 FROM claus_credit_requests WHERE accounted_cost IS NULL)
    RETURNING id, deposit_address, key_id, deposit_tx
  ), claimed AS (
    INSERT INTO claus_payment_ids(id, absent) SELECT ${id}, false FROM admitted RETURNING id
  ) INSERT INTO claus_credit_requests(id, request_hash, reserved_max, status, outcome, binding)
    SELECT ${id}, ${hash}, ${String(amount)}::bigint, 'reserved',
      jsonb_build_object('activeUntil', (statement_timestamp() + ${activeMs}::integer * interval '1 millisecond')::text),
      jsonb_build_object('depositAddress', admitted.deposit_address, 'keyId', admitted.key_id, 'depositTransaction', admitted.deposit_tx, 'endpoint', 'https://api.surplusintelligence.ai/v1/responses')
    FROM claimed CROSS JOIN admitted RETURNING id`;
}

export async function readCredit(db, id) {
  if (!validId(id)) return null;
  const rows = await db`SELECT id, request_hash, reserved_max::text, status, response, outcome,
    provider_request_id, http_status, accounted_cost::text, binding, payload_hash, dispatched_at::text, created_at::text
    FROM claus_credit_requests WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function startCredit(db, id, payloadHash, clientRequestId = null) {
  if (!validId(id) || typeof payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(payloadHash)) return false;
  if (clientRequestId !== null && !/^claus-[a-f0-9]{64}$/.test(clientRequestId)) return false;
  const rows = await db`UPDATE claus_credit_requests SET status = 'submitting', payload_hash = ${payloadHash}, dispatched_at = clock_timestamp(),
    binding = binding || ${JSON.stringify(clientRequestId === null ? {} : {clientRequestId})}::jsonb
    WHERE id = ${id} AND status = 'reserved'
      AND (outcome->>'activeUntil')::timestamptz > clock_timestamp()
      AND EXISTS (SELECT 1 FROM claus_credit_pool WHERE id = true AND state = 'funded') RETURNING id`;
  return rows.length === 1;
}

export async function recordCreditHeaders(db, id, {requestId, httpStatus} = {}) {
  if (!validId(id) || (requestId !== null && !validId(requestId)) || !Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) return false;
  const rows = await db`UPDATE claus_credit_requests
    SET provider_request_id = COALESCE(provider_request_id, ${requestId}::text), http_status = COALESCE(http_status, ${httpStatus}::integer)
    WHERE id = ${id} AND status = 'submitting'
      AND (provider_request_id IS NULL OR provider_request_id = ${requestId}::text) RETURNING id`;
  return rows.length === 1;
}

/** Caller verifies header cost. Null cost holds the maximum indefinitely;
 * terminal CAS is immutable, including uncertain results. Overruns freeze the
 * pool and retain the hold instead of trusting a cost above the reservation.
 */
export async function finishCredit(db, id, {status, response = null, outcome = null, amount = null} = {}) {
  const cost = amount === null ? null : typeof amount === 'string' ? integer(amount) : null;
  if (!validId(id) || !['completed', 'failed', 'uncertain'].includes(status)
    || (amount !== null && cost === null)) throw Error('invalid_credit_finish');
  const encodedResponse = JSON.stringify(response), encodedOutcome = JSON.stringify(outcome);
  if (encodedResponse === undefined || encodedOutcome === undefined) throw Error('invalid_credit_finish');
  const rows = await db`WITH locked AS MATERIALIZED (
    SELECT id, committed FROM claus_credit_pool WHERE id = true FOR UPDATE
  ), finished AS (
    UPDATE claus_credit_requests SET
      status = CASE WHEN ${amount}::bigint > reserved_max THEN 'uncertain' ELSE ${status} END,
      response = ${encodedResponse}::jsonb, outcome = ${encodedOutcome}::jsonb,
      accounted_cost = CASE WHEN ${amount}::bigint <= reserved_max THEN ${amount}::bigint END
    FROM locked WHERE claus_credit_requests.id = ${id} AND status IN ('reserved', 'submitting')
      AND accounted_cost IS NULL AND locked.committed >= reserved_max
    RETURNING reserved_max - COALESCE(accounted_cost, reserved_max) AS released,
      ${amount}::bigint > reserved_max AS overrun
  ) UPDATE claus_credit_pool SET committed = claus_credit_pool.committed - finished.released,
      state = CASE WHEN finished.overrun THEN 'frozen' ELSE state END
    FROM finished, locked WHERE claus_credit_pool.id = locked.id RETURNING claus_credit_pool.id`;
  return rows.length === 1;
}
