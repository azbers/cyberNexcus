-- 0010_auth_audit_dry_run_event.sql
-- Allow epoch bump dry-run audit event type.

DO $$
DECLARE
  event_type_constraint_name TEXT;
BEGIN
  SELECT conname
    INTO event_type_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'auth_audit_logs'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%event_type IN%'
  ORDER BY oid
  LIMIT 1;

  IF event_type_constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE auth_audit_logs DROP CONSTRAINT %I',
      event_type_constraint_name
    );
  END IF;
END $$;

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
      'TOKEN_EPOCH_BUMP_DRY_RUN'
    )
  );
