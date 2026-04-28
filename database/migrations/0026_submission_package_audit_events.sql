-- 0026_submission_package_audit_events.sql
-- Extend auth audit event CHECK for Phase 10 submission package events.

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
      'ORG_REACTIVATED',
      'ASSESSMENT_DRAFT_CREATED',
      'ASSESSMENT_ITEM_STATUS_UPDATED',
      'ASSESSMENT_INTERNAL_FINALIZED',
      'EVIDENCE_UPLOADED',
      'EVIDENCE_REMOVED',
      'EVIDENCE_DOWNLOADED',
      'EVIDENCE_CHECKLIST_UPSERTED',
      'ASSESSMENT_SCORE_CALCULATED',
      'SUBMISSION_READINESS_UPSERTED',
      'ASSESSMENT_MARKED_READY_FOR_SUBMISSION',
      'SUBMISSION_PACKAGE_CREATED',
      'SUBMISSION_PACKAGE_VOIDED'
    )
  );
