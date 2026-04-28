-- 0005_auth_behavior_risk.sql
-- Phase 2 hardening v3: behavior risk, token epoch, rate limit counters, and hash-only session model.

ALTER TABLE auth_sessions
  ADD COLUMN IF NOT EXISTS device_context_hash TEXT;

ALTER TABLE auth_sessions
  DROP CONSTRAINT IF EXISTS chk_auth_sessions_device_context_hash;

ALTER TABLE auth_sessions
  ADD CONSTRAINT chk_auth_sessions_device_context_hash
  CHECK (
    device_context_hash IS NULL
    OR device_context_hash ~ '^[0-9a-f]{64}$'
  );

CREATE INDEX IF NOT EXISTS idx_auth_sessions_device_context_hash
  ON auth_sessions (device_context_hash);

-- Hash-only refresh model: remove reversible issued token persistence.
ALTER TABLE auth_sessions
  DROP CONSTRAINT IF EXISTS chk_auth_sessions_issued_tokens_presence;

ALTER TABLE auth_sessions
  DROP CONSTRAINT IF EXISTS chk_auth_sessions_issued_tokens_key_version;

ALTER TABLE auth_sessions
  DROP COLUMN IF EXISTS issued_access_token_ciphertext,
  DROP COLUMN IF EXISTS issued_refresh_token_ciphertext,
  DROP COLUMN IF EXISTS issued_tokens_key_version,
  DROP COLUMN IF EXISTS issued_tokens_stored_at;

DROP INDEX IF EXISTS idx_auth_sessions_issued_tokens_stored_at;

CREATE TABLE IF NOT EXISTS system_security_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  token_epoch TIMESTAMPTZ NOT NULL DEFAULT TIMESTAMPTZ '1970-01-01 00:00:00+00',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO system_security_state (singleton)
VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS auth_session_behavior_buckets (
  session_id UUID NOT NULL REFERENCES auth_sessions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  bucket_start TIMESTAMPTZ NOT NULL,
  refresh_count INTEGER NOT NULL DEFAULT 0 CHECK (refresh_count >= 0),
  device_mismatch_count INTEGER NOT NULL DEFAULT 0 CHECK (device_mismatch_count >= 0),
  ip_churn_count INTEGER NOT NULL DEFAULT 0 CHECK (ip_churn_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_auth_behavior_buckets_session_bucket
  ON auth_session_behavior_buckets (session_id, bucket_start DESC);

CREATE TABLE IF NOT EXISTS auth_session_risk_state (
  session_id UUID PRIMARY KEY REFERENCES auth_sessions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  risk_score NUMERIC NOT NULL DEFAULT 0 CHECK (risk_score >= 0),
  confidence_score NUMERIC NOT NULL DEFAULT 0 CHECK (confidence_score >= 0),
  effective_risk_score NUMERIC NOT NULL DEFAULT 0 CHECK (effective_risk_score >= 0),
  risk_level TEXT NOT NULL DEFAULT 'LOW' CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
  sensitive_reauth_required BOOLEAN NOT NULL DEFAULT FALSE,
  baseline_refresh_interval_seconds NUMERIC,
  baseline_confidence NUMERIC NOT NULL DEFAULT 0 CHECK (baseline_confidence >= 0),
  last_refresh_at TIMESTAMPTZ,
  last_decay_at TIMESTAMPTZ,
  last_anomaly_at TIMESTAMPTZ,
  anomaly_reasons JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(anomaly_reasons) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_auth_session_risk_lookup
  ON auth_session_risk_state (session_id);

CREATE TABLE IF NOT EXISTS auth_rate_limit_counters (
  counter_key TEXT NOT NULL,
  bucket_start TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (counter_key, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_auth_rate_limit_key_bucket
  ON auth_rate_limit_counters (counter_key, bucket_start DESC);

CREATE TABLE IF NOT EXISTS auth_audit_dedup_counters (
  dedup_key TEXT NOT NULL,
  bucket_start TIMESTAMPTZ NOT NULL,
  repeat_count INTEGER NOT NULL DEFAULT 0 CHECK (repeat_count >= 0),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (dedup_key, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_dedup_key_bucket
  ON auth_audit_dedup_counters (dedup_key, bucket_start DESC);
