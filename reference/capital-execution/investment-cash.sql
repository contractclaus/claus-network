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
 recent=recent+(SELECT COALESCE(sum(spent),0) FROM claus_capital_investments WHERE settled_at>=c.cash_started_at-interval '5 seconds');
 cash_available=c.cash_micro-held-recent-c.reserve_micro-investment_held-GREATEST(0,c.investment_micro-invested-investment_held);
 RETURN GREATEST(0,LEAST(cash_available,c.daily_micro-daily-held,c.monthly_micro-monthly-held));
END $$;
