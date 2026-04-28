-- 0027_external_submission_intake.sql
-- Phase 11: external submission intake records for sealed submission packages.

CREATE TABLE IF NOT EXISTS external_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL
    REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  submission_package_id UUID NOT NULL
    REFERENCES assessment_submission_packages(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  assessment_cycle_id UUID NOT NULL
    REFERENCES assessment_cycles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  submission_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('SUBMITTED', 'WITHDRAWN')),

  submitted_by_user_id UUID NOT NULL
    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  withdrawn_by_user_id UUID
    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  withdrawn_at TIMESTAMPTZ,
  withdraw_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (length(btrim(submission_number)) > 0),
  CHECK (
    (
      status = 'SUBMITTED'
      AND withdrawn_by_user_id IS NULL
      AND withdrawn_at IS NULL
      AND withdraw_reason IS NULL
    )
    OR
    (
      status = 'WITHDRAWN'
      AND withdrawn_by_user_id IS NOT NULL
      AND withdrawn_at IS NOT NULL
      AND withdraw_reason IS NOT NULL
      AND length(btrim(withdraw_reason)) BETWEEN 10 AND 2000
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_external_submissions_one_submitted_per_package
  ON external_submissions (submission_package_id)
  WHERE status = 'SUBMITTED';

CREATE INDEX IF NOT EXISTS idx_external_submissions_org
  ON external_submissions (org_id);

CREATE INDEX IF NOT EXISTS idx_external_submissions_cycle
  ON external_submissions (assessment_cycle_id);

CREATE INDEX IF NOT EXISTS idx_external_submissions_package
  ON external_submissions (submission_package_id);

CREATE INDEX IF NOT EXISTS idx_external_submissions_submission_number
  ON external_submissions (submission_number);

CREATE INDEX IF NOT EXISTS idx_external_submissions_status
  ON external_submissions (status);

CREATE OR REPLACE FUNCTION trg_external_submission_immutable_fields()
RETURNS trigger AS $$
BEGIN
  IF NEW.submission_number IS DISTINCT FROM OLD.submission_number
    OR NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.submission_package_id IS DISTINCT FROM OLD.submission_package_id
    OR NEW.assessment_cycle_id IS DISTINCT FROM OLD.assessment_cycle_id
    OR NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'external submission immutable fields cannot be changed'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS external_submissions_immutable_fields
  ON external_submissions;
CREATE TRIGGER external_submissions_immutable_fields
BEFORE UPDATE ON external_submissions
FOR EACH ROW
EXECUTE FUNCTION trg_external_submission_immutable_fields();

DROP TRIGGER IF EXISTS external_submissions_set_updated_at
  ON external_submissions;
CREATE TRIGGER external_submissions_set_updated_at
BEFORE UPDATE ON external_submissions
FOR EACH ROW
EXECUTE FUNCTION trg_set_updated_at();
