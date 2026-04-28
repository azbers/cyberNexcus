-- 0012_org_lifecycle_audit_events.sql
-- Extend audit event types for organization lifecycle actions.

ALTER TABLE auth_audit_logs
  DROP CONSTRAINT IF EXISTS chk_auth_audit_logs_event_type;

ALTER TABLE auth_audit_logs
  ADD CONSTRAINT chk_auth_audit_logs_event_type
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
      'CRITICAL_SECURITY_EVENT',
      'TOKEN_EPOCH_BUMP_DRY_RUN',
      'ORG_APPROVED',
      'ORG_REJECTED',
      'ORG_SUSPENDED',
      'ORG_REACTIVATED'
    )
  );
