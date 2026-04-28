-- 0011_auth_audit_event_constraint_cleanup.sql
-- Remove legacy event_type list constraints and keep the canonical named constraint.

DO $$
DECLARE
  stale_constraint RECORD;
BEGIN
  FOR stale_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'auth_audit_logs'::regclass
      AND contype = 'c'
      AND conname <> 'chk_auth_audit_logs_event_type'
      AND pg_get_constraintdef(oid) ILIKE '%event_type = ANY%'
  LOOP
    EXECUTE format(
      'ALTER TABLE auth_audit_logs DROP CONSTRAINT %I',
      stale_constraint.conname
    );
  END LOOP;
END $$;
