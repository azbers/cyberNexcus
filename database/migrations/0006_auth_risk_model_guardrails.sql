-- 0006_auth_risk_model_guardrails.sql
-- Final hardening: baseline poisoning guardrails and split risk model.

ALTER TABLE auth_session_risk_state
  ADD COLUMN IF NOT EXISTS transient_risk_score NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS persistent_risk_score NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE auth_session_risk_state
  DROP CONSTRAINT IF EXISTS chk_auth_session_risk_state_transient_non_negative;

ALTER TABLE auth_session_risk_state
  ADD CONSTRAINT chk_auth_session_risk_state_transient_non_negative
  CHECK (transient_risk_score >= 0);

ALTER TABLE auth_session_risk_state
  DROP CONSTRAINT IF EXISTS chk_auth_session_risk_state_persistent_non_negative;

ALTER TABLE auth_session_risk_state
  ADD CONSTRAINT chk_auth_session_risk_state_persistent_non_negative
  CHECK (persistent_risk_score >= 0);

-- Backfill split scores for existing rows.
UPDATE auth_session_risk_state
SET transient_risk_score = CASE
      WHEN transient_risk_score = 0 THEN risk_score
      ELSE transient_risk_score
    END,
    persistent_risk_score = CASE
      WHEN persistent_risk_score = 0 THEN 0
      ELSE persistent_risk_score
    END;
