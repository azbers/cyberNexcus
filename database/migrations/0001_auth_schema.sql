-- 0001_auth_schema.sql
-- Auth schema baseline for PostgreSQL (CHECK constraints, no enum types)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  normalized_name TEXT GENERATED ALWAYS AS (lower(btrim(name))) STORED,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED')),
  rejection_reason TEXT,
  suspended_at TIMESTAMPTZ,
  deactivated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(btrim(name)) > 0)
);

-- Soft duplicate handling in application; index for fast normalized lookups
CREATE INDEX IF NOT EXISTS idx_organizations_normalized_name
  ON organizations (normalized_name);

CREATE INDEX IF NOT EXISTS idx_organizations_status
  ON organizations (status);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'auditor', 'commenter', 'viewer', 'responsible_officer', 'it_security_lead')),
  token_version INTEGER NOT NULL DEFAULT 0 CHECK (token_version >= 0),
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TIMESTAMPTZ,
  deactivated_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CHECK (length(password_hash) > 0)
);

-- Required
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_org_email_ci
  ON users (org_id, lower(email));

-- Required
CREATE INDEX IF NOT EXISTS idx_users_email_lookup
  ON users (org_id, lower(email));

CREATE INDEX IF NOT EXISTS idx_users_org_id
  ON users (org_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  org_id UUID NOT NULL REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  session_family_id UUID NOT NULL,
  refresh_token_hash TEXT NOT NULL,
  user_agent TEXT,
  ip_address INET,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  idle_expires_at TIMESTAMPTZ NOT NULL,
  rotated_at TIMESTAMPTZ,
  replaced_by_session_id UUID REFERENCES auth_sessions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (refresh_token_hash = lower(refresh_token_hash)),
  CHECK (refresh_token_hash ~ '^[0-9a-f]{64}$'),
  CHECK (absolute_expires_at > issued_at),
  CHECK (idle_expires_at > issued_at),
  CHECK (idle_expires_at <= absolute_expires_at),
  CHECK (replaced_by_session_id IS NULL OR replaced_by_session_id <> id),
  CHECK (
    (revoked_at IS NULL AND revoke_reason IS NULL)
    OR
    (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL AND length(btrim(revoke_reason)) > 0)
  )
);

-- Required
CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_sessions_refresh_token_hash
  ON auth_sessions (refresh_token_hash);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id
  ON auth_sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_org_id
  ON auth_sessions (org_id);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_family_id
  ON auth_sessions (session_family_id);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_family_user
  ON auth_sessions (session_family_id, user_id);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_replaced_by
  ON auth_sessions (replaced_by_session_id);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_active_by_user
  ON auth_sessions (user_id, last_used_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
  ON auth_sessions (absolute_expires_at, idle_expires_at);

CREATE TABLE IF NOT EXISTS password_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(password_hash) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_password_history_user_hash
  ON password_history (user_id, password_hash);

CREATE INDEX IF NOT EXISTS idx_password_history_user_created
  ON password_history (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  org_id UUID NOT NULL REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (token_hash = lower(token_hash)),
  CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_verification_tokens_hash_active
  ON email_verification_tokens (token_hash)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user
  ON email_verification_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_active
  ON email_verification_tokens (user_id, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  user_id UUID REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  org_id UUID REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  session_id UUID REFERENCES auth_sessions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ip_address INET,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(btrim(event_type)) > 0),
  CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK (org_id IS NOT NULL OR user_id IS NOT NULL),
  CHECK (
    event_type IN (
      'REGISTER',
      'VERIFY_EMAIL',
      'LOGIN_SUCCESS',
      'LOGIN_FAILED',
      'REFRESH',
      'TOKEN_REUSE_DETECTED',
      'LOGOUT',
      'LOGOUT_ALL',
      'LOCKOUT_TRIGGERED',
      'CRITICAL_SECURITY_EVENT'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_logs_org_created
  ON auth_audit_logs (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_audit_logs_user_created
  ON auth_audit_logs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_audit_logs_event_created
  ON auth_audit_logs (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_audit_logs_severity_created
  ON auth_audit_logs (severity, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_audit_logs_session_id
  ON auth_audit_logs (session_id);
