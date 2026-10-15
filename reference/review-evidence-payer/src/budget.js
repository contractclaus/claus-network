// Separate-relay lifetime accounting, in integer micro-USDC. No reset or
// caller-configurable ceiling. `db` is a Neon-compatible SQL template tag.
import {creditStoreDDL} from './credit-store.js';
import {creditWorkDDL} from './credit-work-store.js';
// The operator may renew this fixed pilot to the separately approved 500- or 600-USDC envelope.
// Runtime callers cannot choose a ceiling; setup never renews or resets it.
const TEXT_MAX = 3000000n;
const IMAGE_MAX = 500000n;
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value);

function integer(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  if (!['string', 'bigint', 'number'].includes(typeof value) || !/^\d{1,18}$/.test(String(value))) return null;
  return BigInt(value);
}

// Store only bounded, flat evidence from the trusted canonical verifier or
// fenced unsigned-failure path. In particular, never accept raw signatures,
// authorizations, arbitrary objects or free-form provider errors.
const proofFields = {
  network: /^eip155:8453$/, scheme: /^(exact|upto)$/, confirmation: /^safe$/,
  asset: /^0x[\da-fA-F]{40}$/, payer: /^0x[\da-fA-F]{40}$/, payTo: /^0x[\da-fA-F]{40}$/,
  authorizedMicroUsdc: /^\d{1,18}$/, nonce: /^(\d{1,78}|0x[\da-fA-F]{64})$/,
  signatureHash: /^0x[\da-fA-F]{64}$/, transaction: /^0x[\da-fA-F]{64}$/,
  transactionBlockHash: /^0x[\da-fA-F]{64}$/, blockHash: /^0x[\da-fA-F]{64}$/,
  transactionBlockNumber: /^\d{1,20}$/, blockNumber: /^\d{1,20}$/, blockTimestamp: /^\d{1,20}$/,
  kind: /^[a-z][a-z0-9_-]{0,79}$/, source: /^[a-z][a-z0-9_-]{0,79}$/,
  failure: /^[a-z][a-z0-9_-]{0,79}$/, payment: /^(not_signed|not_settled|settled)$/,
  id: /^[a-zA-Z0-9:_-]{1,160}$/, requestId: /^[a-zA-Z0-9:_-]{1,160}$/, fenced: 'boolean',
};
function encodeProof(proof) {
  if (!proof || Object.getPrototypeOf(proof) !== Object.prototype) return null;
  const entries = Object.entries(proof);
  if (!entries.length || entries.length > 24) return null;
  for (const [key, value] of entries) {
    const rule = Object.hasOwn(proofFields, key) && proofFields[key];
    if (!rule || (rule === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'string' || !rule.test(value))) return null;
  }
  const encoded = JSON.stringify(proof);
  return Buffer.byteLength(encoded) <= 4096 ? encoded : null;
}

/** Initialize atomically; refuse historical/unbudgeted rows and never refill.
 * The DO statement owns DDL and validation together, including on failure.
 */
export async function setupBudget(db) {
  const sql = `DO $$
    BEGIN
      ${creditStoreDDL}
      ${creditWorkDDL}
      CREATE TABLE IF NOT EXISTS claus_inference (
        id text PRIMARY KEY, request_hash text NOT NULL, status text NOT NULL,
        response jsonb, payment_payload jsonb, outcome jsonb, image_day date,
        image_slot integer, created_at timestamptz NOT NULL DEFAULT now()
      );
      LOCK TABLE claus_inference IN ACCESS EXCLUSIVE MODE;
      ALTER TABLE claus_inference ADD COLUMN IF NOT EXISTS reserved_max bigint;
      ALTER TABLE claus_inference ADD COLUMN IF NOT EXISTS accounted_cost bigint;
      ALTER TABLE claus_inference ADD COLUMN IF NOT EXISTS cost_proof jsonb;
      IF EXISTS (SELECT 1 FROM claus_inference WHERE reserved_max IS NULL
        OR reserved_max < 1 OR reserved_max > CASE WHEN image_day IS NULL THEN 3000000 ELSE 500000 END
        OR (accounted_cost IS NOT NULL AND (accounted_cost < 0 OR accounted_cost > reserved_max OR cost_proof IS NULL))
        OR (accounted_cost IS NOT NULL AND status NOT IN ('failed', 'completed'))
        OR (accounted_cost IS NULL AND cost_proof IS NOT NULL)) THEN
        RAISE EXCEPTION 'payment_budget_unbudgeted_journal';
      END IF;
      CREATE TABLE IF NOT EXISTS claus_payment_budget (
        id boolean PRIMARY KEY DEFAULT true CHECK (id),
        ceiling bigint NOT NULL DEFAULT 100000000 CHECK (ceiling IN (100000000, 500000000, 600000000)),
        committed bigint NOT NULL DEFAULT 0 CHECK (committed >= 0 AND committed <= ceiling),
        network_committed bigint NOT NULL DEFAULT 0 CHECK (network_committed >= 0 AND network_committed <= committed)
      );
      LOCK TABLE claus_payment_budget IN ACCESS EXCLUSIVE MODE;
      IF NOT EXISTS (SELECT 1 FROM claus_payment_budget) THEN
        IF EXISTS (SELECT 1 FROM claus_inference) OR EXISTS (SELECT 1 FROM claus_credit_pool)
          OR EXISTS (SELECT 1 FROM claus_credit_requests) OR EXISTS (SELECT 1 FROM claus_credit_work) THEN
          RAISE EXCEPTION 'payment_budget_missing_with_history';
        END IF;
        INSERT INTO claus_payment_budget(id, ceiling, committed) VALUES (true, 100000000, 0);
      END IF;
      IF (SELECT count(*) FROM claus_payment_budget) <> 1 OR EXISTS (
        SELECT 1 FROM claus_payment_budget WHERE id IS DISTINCT FROM true
          OR ceiling IS NULL OR ceiling NOT IN (100000000, 500000000, 600000000) OR committed IS NULL OR committed < 0 OR committed > ceiling
      ) THEN
        RAISE EXCEPTION 'payment_budget_invalid';
      END IF;
      IF (SELECT committed FROM claus_payment_budget WHERE id = true) <>
        (SELECT COALESCE(SUM(COALESCE(accounted_cost, reserved_max)), 0) FROM claus_inference)
          + (SELECT COALESCE(SUM(allocated), 0) FROM claus_credit_pool)
          + (SELECT COALESCE(SUM(COALESCE(accounted_cost, reserved_max)), 0) FROM claus_credit_work) THEN
        RAISE EXCEPTION 'payment_budget_journal_mismatch';
      END IF;
      LOCK TABLE claus_credit_pool, claus_credit_requests IN ACCESS EXCLUSIVE MODE;
      IF COALESCE((SELECT committed FROM claus_credit_pool WHERE id = true), 0) <>
        (SELECT COALESCE(SUM(COALESCE(accounted_cost, reserved_max)), 0) FROM claus_credit_requests) THEN
        RAISE EXCEPTION 'credit_budget_journal_mismatch';
      END IF;
      IF EXISTS (SELECT 1 FROM claus_credit_requests c JOIN claus_inference i USING(id)) THEN
        RAISE EXCEPTION 'payment_rail_conflict';
      END IF;
      IF EXISTS (SELECT 1 FROM claus_credit_work w JOIN claus_inference i USING(id))
        OR EXISTS (SELECT 1 FROM claus_credit_work w JOIN claus_credit_requests c USING(id)) THEN
        RAISE EXCEPTION 'payment_rail_conflict';
      END IF;
      CREATE UNIQUE INDEX IF NOT EXISTS claus_image_daily_slot ON claus_inference(image_day, image_slot);
      CREATE TABLE IF NOT EXISTS claus_payment_ids (
        id text PRIMARY KEY, absent boolean NOT NULL
      );
      IF EXISTS (SELECT 1 FROM claus_inference i JOIN claus_payment_ids k USING(id) WHERE k.absent) THEN
        RAISE EXCEPTION 'payment_id_absence_conflict';
      END IF;
      IF EXISTS (SELECT 1 FROM claus_credit_requests c JOIN claus_payment_ids k USING(id) WHERE k.absent) THEN
        RAISE EXCEPTION 'payment_id_absence_conflict';
      END IF;
      IF EXISTS (SELECT 1 FROM claus_credit_work w JOIN claus_payment_ids k USING(id) WHERE k.absent) THEN
        RAISE EXCEPTION 'payment_id_absence_conflict';
      END IF;
      INSERT INTO claus_payment_ids(id,absent) SELECT id,false FROM claus_inference ON CONFLICT DO NOTHING;
      INSERT INTO claus_payment_ids(id,absent) SELECT id,false FROM claus_credit_requests ON CONFLICT DO NOTHING;
      INSERT INTO claus_payment_ids(id,absent) SELECT id,false FROM claus_credit_work ON CONFLICT DO NOTHING;
    END $$`;
  await db(Object.assign([sql], {raw: [sql]}));
}

/** Reserve the maximum for text or exact/upto images; returns [{id}] or [].
 * A duplicate/slot uniqueness error is propagated: the entire statement,
 * including the budget increase, must roll back. Never swallow it in SQL.
 */
export async function reservePayment(db, {id, hash, maximum, isImage, activeMs, legacy, networkMaximum=0n} = {}) {
  const amount = integer(maximum);
  if (!validId(id) || typeof hash !== 'string' || !hash.length || hash.length > 128 || hash.includes('\0')
    || typeof isImage !== 'boolean' || amount === null || amount < 1n || amount > (isImage ? IMAGE_MAX : TEXT_MAX)
    || !Number.isSafeInteger(activeMs) || activeMs < 1 || activeMs > 800000) throw Error('invalid_payment_reservation');
  const isNetwork=/^network-compute:[a-f0-9]{64}$/.test(id);
  if(isNetwork&&(networkMaximum<=0n||networkMaximum>25000000n||isImage))throw Error('compute_budget_unavailable');
  let day = null, baseline = 0;
  if (isImage) {
    day = legacy?.day;
    baseline = legacy?.maxImageSlot;
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)
      || !Number.isInteger(baseline) || baseline < 0 || baseline > 12) return [];
  }
  // The singleton UPDATE is the admission lock. A concurrently computed image
  // slot can be stale under READ COMMITTED; its unique INSERT must fail and
  // roll back, never leave committed increased without a journal reservation.
  return db`WITH image AS (
      SELECT (statement_timestamp() AT TIME ZONE 'UTC')::date AS day,
        GREATEST(COALESCE((SELECT MAX(image_slot) FROM claus_inference
          WHERE image_day = (statement_timestamp() AT TIME ZONE 'UTC')::date), 0), ${baseline}::integer) + 1 AS slot
    ), admitted AS (
      UPDATE claus_payment_budget SET committed = committed + ${String(amount)}::bigint,
        network_committed = network_committed + CASE WHEN ${isNetwork}::boolean THEN ${String(amount)}::bigint ELSE 0 END
      FROM image WHERE id = true AND ceiling IN (100000000, 500000000, 600000000)
        AND committed >= 0 AND committed + ${String(amount)}::bigint <= ceiling
        AND (NOT ${isNetwork}::boolean OR network_committed + ${String(amount)}::bigint <= ${String(networkMaximum)}::bigint)
        AND (NOT ${isImage}::boolean OR (image.day::text = ${day}::text AND image.slot <= 12))
        AND NOT EXISTS (SELECT 1 FROM claus_inference WHERE reserved_max IS NULL)
      RETURNING claus_payment_budget.id
    ), claimed AS (
      INSERT INTO claus_payment_ids(id,absent) SELECT ${id},false FROM admitted RETURNING id
    )
    INSERT INTO claus_inference(id, request_hash, status, reserved_max, outcome, image_day, image_slot)
      SELECT ${id}, ${hash}, 'reserved', ${String(amount)}::bigint,
        jsonb_build_object('activeUntil', (statement_timestamp() + ${activeMs}::integer * interval '1 millisecond')::text),
        CASE WHEN ${isImage}::boolean THEN image.day END,
        CASE WHEN ${isImage}::boolean THEN image.slot END
      FROM claimed CROSS JOIN image RETURNING id`;
}

// Called only after authoritative frozen-legacy absence. This negative receipt
// serializes with admission through the same unique ID: a returned 404 can
// never be followed by a delayed signature for that ID.
export async function confirmAbsent(db,id) {
  if(!validId(id))return false;
  await db`INSERT INTO claus_payment_ids(id,absent) VALUES(${id},true) ON CONFLICT DO NOTHING`;
  const rows=await db`SELECT absent FROM claus_payment_ids WHERE id=${id}`;
  return rows.length===1&&rows[0].absent===true;
}

/** Returns {limit, committed, remaining} as decimal micro-USDC strings.
 * Missing/invalid setup throws; absence must never look like a fresh budget.
 */
export async function budgetSnapshot(db) {
  const rows = await db`SELECT ceiling::text AS "limit", committed::text AS committed,
      (ceiling - committed)::text AS remaining FROM claus_payment_budget
    WHERE id = true AND ceiling IN (100000000, 500000000, 600000000) AND committed BETWEEN 0 AND ceiling`;
  if (rows.length !== 1) throw Error('payment_budget_missing');
  return rows[0];
}

/** Trusted internal accounting only; caller owns canonical proof verification
 * and signing fences. Returns boolean. Terminal amount/proof are immutable;
 * matching retries succeed, mismatches fail closed without releasing funds.
 */
export async function accountPayment(db, {id, amount, proof} = {}) {
  const cost = integer(amount), encoded = encodeProof(proof);
  if (!validId(id) || cost === null || cost > TEXT_MAX || !encoded
    || (proof.id !== undefined && proof.id !== id) || (proof.requestId !== undefined && proof.requestId !== id)) return false;
  const changed = await db`WITH locked AS MATERIALIZED (
      SELECT id, committed FROM claus_payment_budget
      WHERE id = true AND ceiling IN (100000000, 500000000, 600000000) AND committed BETWEEN 0 AND ceiling FOR UPDATE
    ), accounted AS (
      UPDATE claus_inference SET accounted_cost = ${String(cost)}::bigint, cost_proof = ${encoded}::jsonb
      FROM locked WHERE claus_inference.id = ${id} AND status IN ('failed', 'completed')
        AND accounted_cost IS NULL AND cost_proof IS NULL
        AND reserved_max BETWEEN 1 AND CASE WHEN image_day IS NULL THEN 3000000 ELSE 500000 END
        AND ${String(cost)}::bigint <= reserved_max AND locked.committed >= reserved_max
      RETURNING reserved_max - accounted_cost AS released
    )
    UPDATE claus_payment_budget SET committed = claus_payment_budget.committed - accounted.released,
      network_committed = claus_payment_budget.network_committed - CASE WHEN ${/^network-compute:[a-f0-9]{64}$/.test(id)}::boolean THEN accounted.released ELSE 0 END
      FROM accounted, locked WHERE claus_payment_budget.id = locked.id RETURNING claus_payment_budget.id`;
  if (changed.length) return true;
  // Fresh statement snapshot also handles a reconciliation that won the CAS
  // while this call waited for the singleton lock.
  const same = await db`SELECT i.id FROM claus_inference i, claus_payment_budget b
    WHERE b.id = true AND b.ceiling IN (100000000, 500000000, 600000000) AND b.committed BETWEEN 0 AND b.ceiling
      AND i.id = ${id} AND i.status IN ('failed', 'completed')
      AND i.accounted_cost = ${String(cost)}::bigint AND i.cost_proof = ${encoded}::jsonb
      AND i.reserved_max BETWEEN 1 AND CASE WHEN i.image_day IS NULL THEN 3000000 ELSE 500000 END
      AND i.accounted_cost BETWEEN 0 AND i.reserved_max`;
  return same.length === 1;
}
