-- 0033_pkcert_decision_immutability_guard.sql
-- Tighten Phase 13 decision immutability to reject every UPDATE.

CREATE OR REPLACE FUNCTION trg_pkcert_submission_decision_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'pkcert submission decision records are immutable'
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
