-- 0007_auth_resilience_ops.sql
-- System-resilience hardening: audit dedup sharding and token-epoch operational safeguards.

ALTER TABLE auth_audit_dedup_counters
  ADD COLUMN IF NOT EXISTS shard_id INTEGER NOT NULL DEFAULT 0;

ALTER TABLE auth_audit_dedup_counters
  DROP CONSTRAINT IF EXISTS auth_audit_dedup_counters_pkey;

ALTER TABLE auth_audit_dedup_counters
  ADD CONSTRAINT auth_audit_dedup_counters_pkey
  PRIMARY KEY (dedup_key, bucket_start, shard_id);

ALTER TABLE auth_audit_dedup_counters
  DROP CONSTRAINT IF EXISTS chk_auth_audit_dedup_shard_id_non_negative;

ALTER TABLE auth_audit_dedup_counters
  ADD CONSTRAINT chk_auth_audit_dedup_shard_id_non_negative
  CHECK (shard_id >= 0);

CREATE INDEX IF NOT EXISTS idx_auth_audit_dedup_shard_bucket
  ON auth_audit_dedup_counters (shard_id, bucket_start DESC);

ALTER TABLE system_security_state
  ADD COLUMN IF NOT EXISTS last_bump_reason TEXT,
  ADD COLUMN IF NOT EXISTS last_bumped_by UUID REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS last_bumped_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS auth_token_epoch_bumps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  previous_epoch TIMESTAMPTZ NOT NULL,
  new_epoch TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (new_epoch >= previous_epoch)
);

CREATE INDEX IF NOT EXISTS idx_auth_token_epoch_bumps_created
  ON auth_token_epoch_bumps (created_at DESC);
