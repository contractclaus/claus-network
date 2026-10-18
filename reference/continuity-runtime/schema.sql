CREATE SCHEMA IF NOT EXISTS continuity;
REVOKE ALL ON SCHEMA continuity FROM PUBLIC;
CREATE TABLE IF NOT EXISTS continuity.control (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), epoch bigint NOT NULL DEFAULT 1,
 active_instance text NOT NULL DEFAULT 'primary', phase text NOT NULL DEFAULT 'active',
 lease_until timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z', updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO continuity.control(id) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS continuity.effects (
 id text PRIMARY KEY, input_hash text NOT NULL, kind text NOT NULL, instance text NOT NULL,
 epoch bigint NOT NULL, token text NOT NULL, input jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('claimed','completed','failed','uncertain')),
 result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS continuity.grants (
 id text PRIMARY KEY, amount_micro bigint NOT NULL CHECK(amount_micro>0),
 allocated_micro bigint NOT NULL DEFAULT 0 CHECK(allocated_micro>=0 AND allocated_micro<=amount_micro),
 expires_at timestamptz NOT NULL, source jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS continuity.inference (
 id text PRIMARY KEY, input_hash text NOT NULL, input jsonb NOT NULL,
 route text NOT NULL CHECK(route IN ('primary','independent')), state text NOT NULL,
 maximum_micro bigint NOT NULL, grant_id text REFERENCES continuity.grants(id), provider_id text,
 response jsonb, diagnostic jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS continuity.checkpoints (
 name text PRIMARY KEY, revision bigint NOT NULL, input_hash text NOT NULL, body jsonb NOT NULL,
 source_at timestamptz NOT NULL, saved_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS continuity.events (
 id bigserial PRIMARY KEY, kind text NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS continuity.components (
 name text PRIMARY KEY, deployment text NOT NULL, enrolled_at timestamptz NOT NULL DEFAULT now(),
 last_claim_at timestamptz, last_epoch bigint
);
CREATE TABLE IF NOT EXISTS continuity.replication_state (
 name text PRIMARY KEY, body jsonb NOT NULL, sampled_at timestamptz,
 last_error text, updated_at timestamptz NOT NULL DEFAULT now()
);

UPDATE continuity.control SET lease_until='1970-01-01T00:00:00Z' WHERE lease_until='-infinity';
ALTER TABLE continuity.control ALTER COLUMN lease_until SET DEFAULT '1970-01-01T00:00:00Z';

ALTER TABLE continuity.control ADD COLUMN IF NOT EXISTS enforce_effects boolean NOT NULL DEFAULT false;
ALTER TABLE continuity.control ADD COLUMN IF NOT EXISTS transition_not_before timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z';
