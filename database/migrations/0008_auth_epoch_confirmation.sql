-- 0008_auth_epoch_confirmation.sql
-- Two-step confirmation safety lock for global token epoch bump.

CREATE TABLE IF NOT EXISTS auth_token_epoch_bump_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_user_id UUID NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  confirmation_token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELED')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  confirmed_by_user_id UUID REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  canceled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (confirmation_token_hash = lower(confirmation_token_hash)),
  CHECK (confirmation_token_hash ~ '^[0-9a-f]{64}$'),
  CHECK (expires_at > requested_at),
  CHECK (
    (status = 'PENDING' AND confirmed_at IS NULL AND confirmed_by_user_id IS NULL AND canceled_at IS NULL)
    OR
    (status = 'CONFIRMED' AND confirmed_at IS NOT NULL AND confirmed_by_user_id IS NOT NULL AND canceled_at IS NULL)
    OR
    (status = 'EXPIRED' AND canceled_at IS NULL)
    OR
    (status = 'CANCELED' AND canceled_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_token_epoch_bump_requests_token_hash
  ON auth_token_epoch_bump_requests (confirmation_token_hash);

CREATE INDEX IF NOT EXISTS idx_auth_token_epoch_bump_requests_status_expires
  ON auth_token_epoch_bump_requests (status, expires_at);

CREATE INDEX IF NOT EXISTS idx_auth_token_epoch_bump_requests_requester_requested
  ON auth_token_epoch_bump_requests (requester_user_id, requested_at DESC);
