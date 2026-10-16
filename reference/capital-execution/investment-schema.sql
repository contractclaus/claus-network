-- Additive; existing operating/unknown commitments are retained.
CREATE UNIQUE INDEX IF NOT EXISTS claus_capital_escrow_unique ON claus_capital_investments ((binding->'capital'->'execution'->>'escrow'));
CREATE TABLE IF NOT EXISTS claus_capital_signatures (
 id text PRIMARY KEY, investment_id text NOT NULL REFERENCES claus_capital_investments(id),
 action text NOT NULL CHECK(action IN ('fund','release')),
 input_hash text NOT NULL, input jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('reserved','signing','signed')),
 signature text, payload_hash text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(investment_id,action), CHECK((state='signed')=(signature IS NOT NULL))
);
