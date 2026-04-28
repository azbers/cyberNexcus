-- 0003_auth_session_issued_tokens.sql
-- Persist encrypted issued token pairs for deterministic token return.

ALTER TABLE auth_sessions
  ADD COLUMN IF NOT EXISTS issued_access_token_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS issued_refresh_token_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS issued_tokens_key_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS issued_tokens_stored_at TIMESTAMPTZ;

ALTER TABLE auth_sessions
  DROP CONSTRAINT IF EXISTS chk_auth_sessions_issued_tokens_presence;

ALTER TABLE auth_sessions
  ADD CONSTRAINT chk_auth_sessions_issued_tokens_presence
  CHECK (
    (
      issued_access_token_ciphertext IS NULL
      AND issued_refresh_token_ciphertext IS NULL
      AND issued_tokens_stored_at IS NULL
    )
    OR
    (
      issued_access_token_ciphertext IS NOT NULL
      AND issued_refresh_token_ciphertext IS NOT NULL
      AND issued_tokens_stored_at IS NOT NULL
    )
  );

ALTER TABLE auth_sessions
  DROP CONSTRAINT IF EXISTS chk_auth_sessions_issued_tokens_key_version;

ALTER TABLE auth_sessions
  ADD CONSTRAINT chk_auth_sessions_issued_tokens_key_version
  CHECK (issued_tokens_key_version > 0);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_issued_tokens_stored_at
  ON auth_sessions (issued_tokens_stored_at);
