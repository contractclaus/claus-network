-- Operator migration. No runtime reset, balance grant, or financial action.
ALTER TABLE claus_payment_budget ADD COLUMN IF NOT EXISTS capital_mode boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS claus_capital_control(
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 policy_hash text NOT NULL CHECK(policy_hash='a21b0e70568a888cdb95126b35c57f3b310ada00962a008ff76273ad13adc59c'),
 state text NOT NULL CHECK(state IN ('prepared','active','revoked')),
 approval jsonb NOT NULL,
 daily_micro bigint NOT NULL DEFAULT 280000000 CHECK(daily_micro=280000000),
 monthly_micro bigint NOT NULL DEFAULT 8400000000 CHECK(monthly_micro=8400000000),
 reserve_micro bigint NOT NULL DEFAULT 560000000 CHECK(reserve_micro=560000000),
 investment_micro bigint NOT NULL DEFAULT 100000000 CHECK(investment_micro=100000000),
 cash_micro bigint CHECK(cash_micro>=0),cash_started_at timestamptz,cash_block bigint,cash_hash text,
 activated_at timestamptz,revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS claus_capital_investments(
 id text PRIMARY KEY,project_id text NOT NULL,terms_hash text NOT NULL,adapter_hash text NOT NULL,
 amount bigint NOT NULL CHECK(amount BETWEEN 1 AND 25000000),
 state text NOT NULL CHECK(state IN ('reserved','submitted','settled','cancelled')),
 spent bigint CHECK(spent BETWEEN 0 AND amount),binding jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),settled_at timestamptz,
 CHECK((state IN ('settled','cancelled'))=(spent IS NOT NULL))
);
ALTER TABLE claus_inference ADD COLUMN IF NOT EXISTS capital_accounted_at timestamptz;
ALTER TABLE claus_credit_work ADD COLUMN IF NOT EXISTS capital_accounted_at timestamptz;
ALTER TABLE claus_credit_requests ADD COLUMN IF NOT EXISTS capital_accounted_at timestamptz;
-- Historical canonical settlement observations are conservative: a delayed
-- proof is counted at its observation, not moved back to request creation.
UPDATE claus_inference SET capital_accounted_at=CASE WHEN cost_proof->>'blockTimestamp' ~ '^[0-9]{1,12}$'
 THEN GREATEST(created_at,to_timestamp((cost_proof->>'blockTimestamp')::double precision)) ELSE clock_timestamp() END
 WHERE accounted_cost IS NOT NULL AND capital_accounted_at IS NULL;
UPDATE claus_credit_work SET capital_accounted_at=clock_timestamp() WHERE accounted_cost IS NOT NULL AND capital_accounted_at IS NULL;
UPDATE claus_credit_requests SET capital_accounted_at=clock_timestamp() WHERE accounted_cost IS NOT NULL AND capital_accounted_at IS NULL;
CREATE OR REPLACE FUNCTION claus_capital_accounted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.accounted_cost IS DISTINCT FROM OLD.accounted_cost AND NEW.accounted_cost IS NOT NULL THEN
  NEW.capital_accounted_at=clock_timestamp();
 ELSIF NEW.capital_accounted_at IS DISTINCT FROM OLD.capital_accounted_at THEN
  RAISE EXCEPTION 'capital_accounting_time_immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION claus_capital_available(require_fresh boolean DEFAULT true) RETURNS bigint LANGUAGE plpgsql VOLATILE AS $$
DECLARE c claus_capital_control%ROWTYPE; held bigint; daily bigint; monthly bigint; recent bigint; invested bigint; investment_held bigint; cash_available bigint;
BEGIN
 SELECT * INTO c FROM claus_capital_control WHERE id=true;
 IF NOT FOUND OR c.state<>'active' THEN RETURN 0; END IF;
 IF c.cash_started_at IS NULL OR c.cash_started_at<clock_timestamp()-interval '20 seconds' OR c.cash_started_at>clock_timestamp() THEN
  IF require_fresh THEN RAISE EXCEPTION 'capital_cash_snapshot_expired'; ELSE RETURN 0; END IF;
 END IF;
 SELECT COALESCE(sum(reserved_max) FILTER(WHERE accounted_cost IS NULL),0),
 COALESCE(sum(accounted_cost) FILTER(WHERE capital_accounted_at>clock_timestamp()-interval '24 hours'),0),
 COALESCE(sum(accounted_cost) FILTER(WHERE capital_accounted_at>clock_timestamp()-interval '30 days'),0),
 COALESCE(sum(accounted_cost) FILTER(WHERE capital_accounted_at>=c.cash_started_at-interval '5 seconds'),0)
 INTO held,daily,monthly,recent FROM (
  SELECT reserved_max,accounted_cost,capital_accounted_at FROM claus_inference
  UNION ALL SELECT reserved_max,accounted_cost,capital_accounted_at FROM claus_credit_work
  UNION ALL SELECT reserved_max,accounted_cost,capital_accounted_at FROM claus_credit_requests
 ) ledger;
 SELECT COALESCE(sum(spent),0),COALESCE(sum(amount) FILTER(WHERE spent IS NULL),0)
 INTO invested,investment_held FROM claus_capital_investments;
 -- Independent prepaid is conservatively reserved against cash too; prepaid
 -- balances are never added to this wallet or counted as new owner funding.
 cash_available=c.cash_micro-held-recent-c.reserve_micro-investment_held-GREATEST(0,c.investment_micro-invested-investment_held);
 RETURN GREATEST(0,LEAST(cash_available,c.daily_micro-daily-held,c.monthly_micro-monthly-held));
END $$;
CREATE OR REPLACE FUNCTION claus_capital_operating_admit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE enabled boolean; available bigint;
BEGIN
 -- Every rail takes the same lock before querying a fresh statement snapshot.
 SELECT capital_mode INTO enabled FROM claus_payment_budget WHERE id=true FOR UPDATE;
 IF enabled THEN
  available=claus_capital_available(true);
  IF NEW.reserved_max>available THEN RAISE EXCEPTION 'capital_operating_envelope_exhausted'; END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['claus_inference','claus_credit_work','claus_credit_requests'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS capital_operating_admit ON %I',t);
  EXECUTE format('CREATE TRIGGER capital_operating_admit BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION claus_capital_operating_admit()',t);
  EXECUTE format('DROP TRIGGER IF EXISTS capital_accounted ON %I',t);
  EXECUTE format('CREATE TRIGGER capital_accounted BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION claus_capital_accounted()',t);
 END LOOP;
END $$;
-- Replace only the old ceiling-format constraint. The committed equation,
-- nonnegative amounts, network sublimit and original financial rows stay.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='claus_payment_budget'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%ceiling%' AND pg_get_constraintdef(oid) NOT LIKE '%committed%'
 LOOP EXECUTE format('ALTER TABLE claus_payment_budget DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE claus_payment_budget ADD CONSTRAINT capital_ceiling_format CHECK(capital_mode OR ceiling IN (100000000,500000000) OR ceiling BETWEEN 600000000 AND 1200000000);
CREATE OR REPLACE FUNCTION claus_capital_before_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('authorizing','submitting')
 AND (SELECT capital_mode FROM claus_payment_budget WHERE id=true)
 AND NOT EXISTS(SELECT 1 FROM claus_capital_control WHERE id=true AND state='active') THEN
  RAISE EXCEPTION 'capital_mandate_revoked';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['claus_inference','claus_credit_work','claus_credit_requests'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS capital_before_dispatch ON %I',t);
  EXECUTE format('CREATE TRIGGER capital_before_dispatch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION claus_capital_before_dispatch()',t);
 END LOOP;
END $$;
