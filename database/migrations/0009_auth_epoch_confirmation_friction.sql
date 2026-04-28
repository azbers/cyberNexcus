-- 0009_auth_epoch_confirmation_friction.sql
-- Add confirmation friction and context binding for epoch bump requests.

ALTER TABLE auth_token_epoch_bump_requests
  ADD COLUMN IF NOT EXISTS requester_session_id UUID REFERENCES auth_sessions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS requester_context_hash TEXT;

-- Expire legacy pending requests created before binding columns existed.
UPDATE auth_token_epoch_bump_requests
SET status = 'EXPIRED',
    updated_at = now()
WHERE status = 'PENDING'
  AND (requester_session_id IS NULL OR requester_context_hash IS NULL);

ALTER TABLE auth_token_epoch_bump_requests
  DROP CONSTRAINT IF EXISTS chk_epoch_bump_request_context_hash;

ALTER TABLE auth_token_epoch_bump_requests
  ADD CONSTRAINT chk_epoch_bump_request_context_hash
  CHECK (
    requester_context_hash IS NULL
    OR requester_context_hash ~ '^[0-9a-f]{64}$'
  );

ALTER TABLE auth_token_epoch_bump_requests
  DROP CONSTRAINT IF EXISTS chk_epoch_bump_request_pending_binding;

ALTER TABLE auth_token_epoch_bump_requests
  ADD CONSTRAINT chk_epoch_bump_request_pending_binding
  CHECK (
    status <> 'PENDING'
    OR (requester_session_id IS NOT NULL AND requester_context_hash IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_auth_token_epoch_bump_requests_requester_session
  ON auth_token_epoch_bump_requests (requester_session_id);
