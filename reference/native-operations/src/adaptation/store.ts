import {managedDatabase,managedSchemaReady} from '../database-schema.js';
import type {LabDatabase, LabQuery} from '../lab-db.js';
import {
  adaptationHash, DEFAULT_ADAPTATION_PROFILE, digest, patchProfile, validateId, validatePatch,
  validateProfile, validateRationale, validateRevision, validateSource,
  type AdaptationCurrent, type AdaptationPatch, type AdaptationProfile, type AdaptationSource,
} from './schema.js';

export type AdaptationKind = 'initial' | 'apply' | 'rollback' | 'control';
export interface AdaptationReceipt extends AdaptationCurrent {
  readonly kind: 'apply' | 'rollback';
  readonly replayed: boolean;
}
/** Private audit output. Never pass history or mutation inputs into a model/public renderer. */
export interface AdaptationHistoryEntry extends AdaptationCurrent {
  readonly kind: AdaptationKind;
  readonly requestId: string | null;
  readonly reason: string | null;
  readonly tradeoff: string | null;
  readonly source: AdaptationSource | null;
  readonly restoredFrom: number | null;
}
interface RequestInput {
  version: 1;
  kind: 'apply' | 'rollback';
  expectedRevision: number;
  patch: AdaptationPatch | null;
  revision: number | null;
  reason: string;
  tradeoff: string | null;
  source: AdaptationSource;
}
interface VersionRow {
  revision: string | number; kind: AdaptationKind; enabled: boolean; profile: unknown; hash: string;
  created_at: string | Date; request_id: string | null; restored_from: string | number | null;
  input?: RequestInput | null;
}
type Outcome = {error: string} | {receipt: AdaptationReceipt};

function snapshot(row: VersionRow): AdaptationCurrent {
  const revision = validateRevision(Number(row.revision)), profile = validateProfile(row.profile);
  if (typeof row.enabled !== 'boolean' || adaptationHash(profile, row.enabled) !== row.hash) throw Error('adaptation_corrupt_snapshot');
  return {revision, profile, enabled: row.enabled, hash: row.hash, updatedAt: new Date(row.created_at).toISOString()};
}

export class AdaptationStore {
  constructor(readonly db: LabDatabase) {}

  async initialize(): Promise<void> {if(managedDatabase())return managedSchemaReady();
    await this.db.transaction(async q => {
      await q.query(`
        CREATE TABLE IF NOT EXISTS claus_adaptation_versions (
          revision bigint PRIMARY KEY CHECK(revision>=0),
          kind text NOT NULL CHECK(kind IN ('initial','apply','rollback','control')),
          enabled boolean NOT NULL, profile jsonb NOT NULL,
          hash text NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'), request_id text UNIQUE,
          restored_from bigint REFERENCES claus_adaptation_versions(revision),
          created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          CHECK((kind IN ('apply','rollback')) = (request_id IS NOT NULL)),
          CHECK((kind='rollback') = (restored_from IS NOT NULL))
        );
        CREATE TABLE IF NOT EXISTS claus_adaptation_requests (
          id text PRIMARY KEY, input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'), input jsonb NOT NULL,
          accepted_revision bigint UNIQUE REFERENCES claus_adaptation_versions(revision), error text,
          created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          CHECK((accepted_revision IS NULL) <> (error IS NULL))
        );
        CREATE TABLE IF NOT EXISTS claus_adaptation_control (
          id boolean PRIMARY KEY DEFAULT true CHECK(id),
          revision bigint NOT NULL REFERENCES claus_adaptation_versions(revision)
        );
        CREATE INDEX IF NOT EXISTS claus_adaptation_rate_idx ON claus_adaptation_versions(kind,created_at);
        CREATE OR REPLACE FUNCTION claus_adaptation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'adaptation_immutable_history'; END;
        $$;
        DROP TRIGGER IF EXISTS claus_adaptation_versions_immutable ON claus_adaptation_versions;
        CREATE TRIGGER claus_adaptation_versions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON claus_adaptation_versions
          FOR EACH STATEMENT EXECUTE FUNCTION claus_adaptation_immutable();
        DROP TRIGGER IF EXISTS claus_adaptation_requests_immutable ON claus_adaptation_requests;
        CREATE TRIGGER claus_adaptation_requests_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON claus_adaptation_requests
          FOR EACH STATEMENT EXECUTE FUNCTION claus_adaptation_immutable();
      `);
      await q.query(`INSERT INTO claus_adaptation_versions(revision,kind,enabled,profile,hash)
        VALUES(0,'initial',false,$1::jsonb,$2) ON CONFLICT DO NOTHING`,
      [JSON.stringify(DEFAULT_ADAPTATION_PROFILE), adaptationHash(DEFAULT_ADAPTATION_PROFILE, false)]);
      await q.query('INSERT INTO claus_adaptation_control(id,revision) VALUES(true,0) ON CONFLICT DO NOTHING');
    });
  }

  async current(): Promise<AdaptationCurrent> {
    const row = (await this.db.query<VersionRow>(`SELECT v.* FROM claus_adaptation_control c
      JOIN claus_adaptation_versions v ON v.revision=c.revision WHERE c.id`)).rows[0];
    if (!row) throw Error('adaptation_not_initialized');
    return snapshot(row);
  }

  /** Internal replay provenance: native source edits/deletion cannot rewrite a saved action. */
  async requestSource(id: string): Promise<AdaptationSource | null> {
    const row = (await this.db.query<{input: RequestInput}>('SELECT input FROM claus_adaptation_requests WHERE id=$1', [validateId(id)])).rows[0];
    return row ? validateSource(row.input.source) : null;
  }

  /** Newest first; page with the last revision as beforeRevision. All prose remains private. */
  async history(limit = 50, beforeRevision?: number): Promise<AdaptationHistoryEntry[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('adaptation_invalid_history_limit');
    if (beforeRevision !== undefined) validateRevision(beforeRevision);
    const rows = (await this.db.query<VersionRow>(`SELECT v.*,r.input FROM claus_adaptation_versions v
      LEFT JOIN claus_adaptation_requests r ON r.accepted_revision=v.revision
      WHERE ($1::bigint IS NULL OR v.revision<$1) ORDER BY v.revision DESC LIMIT $2`, [beforeRevision ?? null, limit])).rows;
    return rows.map(row => ({
      ...snapshot(row), kind: row.kind, requestId: row.request_id,
      reason: row.input?.reason ?? null, tradeoff: row.input?.tradeoff ?? null,
      source: row.input ? validateSource(row.input.source) : null,
      restoredFrom: row.restored_from === null ? null : validateRevision(Number(row.restored_from)),
    }));
  }

  async apply(id: string, expectedRevision: number, patch: AdaptationPatch, reason: string, tradeoff: string, source: AdaptationSource): Promise<AdaptationReceipt> {
    const input: RequestInput = {
      version: 1, kind: 'apply', expectedRevision: validateRevision(expectedRevision), patch: validatePatch(patch), revision: null,
      reason: validateRationale(reason, 'reason'), tradeoff: validateRationale(tradeoff, 'tradeoff'), source: validateSource(source),
    };
    if (input.reason.trim().toLowerCase() === input.tradeoff!.trim().toLowerCase()) throw Error('adaptation_invalid_tradeoff');
    return this.mutate(validateId(id), input);
  }

  /** Recovery restores only the profile, never the target revision's enabled flag or old revision number. */
  async rollback(id: string, expectedRevision: number, revision: number, reason: string, source: AdaptationSource): Promise<AdaptationReceipt> {
    const input: RequestInput = {
      version: 1, kind: 'rollback', expectedRevision: validateRevision(expectedRevision), patch: null,
      revision: validateRevision(revision), reason: validateRationale(reason, 'reason'), tradeoff: null, source: validateSource(source),
    };
    return this.mutate(validateId(id), input);
  }

  /** Operator-only integration point: do not expose as a CLAUS/member tool. Same value is a no-op. */
  async control(enabled: boolean): Promise<AdaptationCurrent> {
    if (typeof enabled !== 'boolean') throw Error('adaptation_invalid_control');
    return this.db.transaction(async q => {
      const current = await this.locked(q);
      if (current.enabled === enabled) return current;
      const row = await this.append(q, current, 'control', current.profile, enabled);
      return snapshot(row);
    });
  }

  private async locked(q: LabQuery): Promise<AdaptationCurrent> {
    const control = (await q.query<{revision: string | number}>('SELECT revision FROM claus_adaptation_control WHERE id FOR UPDATE')).rows[0];
    if (!control) throw Error('adaptation_not_initialized');
    const row = (await q.query<VersionRow>('SELECT * FROM claus_adaptation_versions WHERE revision=$1', [control.revision])).rows[0];
    if (!row) throw Error('adaptation_corrupt_snapshot');
    return snapshot(row);
  }

  private async append(q: LabQuery, current: AdaptationCurrent, kind: Exclude<AdaptationKind, 'initial'>,
    profile: AdaptationProfile, enabled: boolean, id: string | null = null, restoredFrom: number | null = null): Promise<VersionRow> {
    const revision = validateRevision(current.revision + 1);
    const row = (await q.query<VersionRow>(`INSERT INTO claus_adaptation_versions(revision,kind,enabled,profile,hash,request_id,restored_from)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING *`,
    [revision, kind, enabled, JSON.stringify(profile), adaptationHash(profile, enabled), id, restoredFrom])).rows[0];
    await q.query('UPDATE claus_adaptation_control SET revision=$1 WHERE id', [revision]);
    return row;
  }

  private async mutate(id: string, input: RequestInput): Promise<AdaptationReceipt> {
    const inputHash = digest(input);
    const outcome: Outcome = await this.db.transaction(async q => {
      // Serializes CAS, ID arbitration, rate checks, controls and rollback across store instances.
      const current = await this.locked(q);
      const previous = (await q.query<{input_hash: string; accepted_revision: string | number | null; error: string | null}>(
        'SELECT input_hash,accepted_revision,error FROM claus_adaptation_requests WHERE id=$1', [id])).rows[0];
      if (previous) {
        if (previous.input_hash !== inputHash) throw Error('adaptation_request_conflict');
        if (previous.error !== null) return {error: previous.error};
        const row = (await q.query<VersionRow>('SELECT * FROM claus_adaptation_versions WHERE revision=$1', [previous.accepted_revision])).rows[0];
        if (!row || row.kind !== input.kind) throw Error('adaptation_corrupt_receipt');
        return {receipt: {...snapshot(row), kind: input.kind, replayed: true}};
      }
      const refuse = async (error: string): Promise<Outcome> => {
        await q.query('INSERT INTO claus_adaptation_requests(id,input_hash,input,error) VALUES($1,$2,$3::jsonb,$4)',
          [id, inputHash, JSON.stringify(input), error]);
        return {error};
      };
      // Commit well-formed refusals too: a failed ID cannot later be repurposed with different bytes.
      if (current.revision !== input.expectedRevision) return refuse('adaptation_revision_conflict');
      if (input.kind === 'apply' && !current.enabled) return refuse('adaptation_disabled');
      let profile: AdaptationProfile;
      if (input.kind === 'rollback') {
        if (input.revision! >= current.revision) return refuse('adaptation_invalid_rollback');
        const target = (await q.query<VersionRow>('SELECT * FROM claus_adaptation_versions WHERE revision=$1', [input.revision])).rows[0];
        if (!target) return refuse('adaptation_revision_missing');
        profile = snapshot(target).profile;
      } else {
        profile = patchProfile(current.profile, input.patch!);
      }
      if (digest(profile) === digest(current.profile)) return refuse('adaptation_no_change');
      if (input.kind === 'apply') {
        const count = (await q.query<{author_count: number; global_count: number}>(`SELECT
          count(*) FILTER(WHERE r.input->'source'->>'authorId'=$1)::int AS author_count, count(*)::int AS global_count
          FROM claus_adaptation_versions v JOIN claus_adaptation_requests r ON r.accepted_revision=v.revision
          WHERE v.kind='apply' AND v.created_at>clock_timestamp()-interval '24 hours'`, [input.source.authorId])).rows[0];
        if (count.author_count >= 1) return refuse('adaptation_author_limit');
        if (count.global_count >= 3) return refuse('adaptation_global_limit');
      }
      const row = await this.append(q, current, input.kind, profile, current.enabled, id, input.revision);
      await q.query('INSERT INTO claus_adaptation_requests(id,input_hash,input,accepted_revision) VALUES($1,$2,$3::jsonb,$4)',
        [id, inputHash, JSON.stringify(input), row.revision]);
      return {receipt: {...snapshot(row), kind: input.kind, replayed: false}};
    });
    if ('error' in outcome) throw Error(outcome.error);
    return outcome.receipt;
  }
}
