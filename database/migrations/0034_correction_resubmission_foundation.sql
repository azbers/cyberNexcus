-- 0034_correction_resubmission_foundation.sql
-- Phase 14: organization-side correction resubmission shell for returned PKCERT decisions.

CREATE TABLE IF NOT EXISTS correction_resubmissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  org_id UUID NOT NULL
    REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  original_external_submission_id UUID NOT NULL
    REFERENCES external_submissions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  original_decision_id UUID NOT NULL
    REFERENCES pkcert_submission_decisions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  original_submission_package_id UUID NOT NULL
    REFERENCES assessment_submission_packages(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  original_assessment_cycle_id UUID NOT NULL
    REFERENCES assessment_cycles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  status TEXT NOT NULL CHECK (
    status IN ('DRAFT', 'READY_FOR_RESUBMISSION', 'VOIDED')
  ),

  correction_reason TEXT NOT NULL CHECK (
    length(btrim(correction_reason)) BETWEEN 20 AND 5000
  ),
  correction_summary TEXT NULL CHECK (
    correction_summary IS NULL OR length(correction_summary) <= 5000
  ),

  created_by_user_id UUID NOT NULL
    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  ready_by_user_id UUID NULL
    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ready_at TIMESTAMPTZ NULL,

  voided_by_user_id UUID NULL
    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  voided_at TIMESTAMPTZ NULL,
  void_reason TEXT NULL,

  CHECK (
    (
      status = 'DRAFT'
      AND ready_by_user_id IS NULL
      AND ready_at IS NULL
      AND voided_by_user_id IS NULL
      AND voided_at IS NULL
      AND void_reason IS NULL
    )
    OR (
      status = 'READY_FOR_RESUBMISSION'
      AND ready_by_user_id IS NOT NULL
      AND ready_at IS NOT NULL
      AND voided_by_user_id IS NULL
      AND voided_at IS NULL
      AND void_reason IS NULL
    )
    OR (
      status = 'VOIDED'
      AND voided_by_user_id IS NOT NULL
      AND voided_at IS NOT NULL
      AND void_reason IS NOT NULL
      AND length(btrim(void_reason)) BETWEEN 10 AND 2000
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_correction_per_decision
  ON correction_resubmissions (original_decision_id)
  WHERE status IN ('DRAFT', 'READY_FOR_RESUBMISSION');

CREATE INDEX IF NOT EXISTS idx_correction_resubmissions_org
  ON correction_resubmissions (org_id);

CREATE INDEX IF NOT EXISTS idx_correction_resubmissions_original_external_submission
  ON correction_resubmissions (original_external_submission_id);

CREATE INDEX IF NOT EXISTS idx_correction_resubmissions_original_decision
  ON correction_resubmissions (original_decision_id);

CREATE INDEX IF NOT EXISTS idx_correction_resubmissions_status
  ON correction_resubmissions (status);

CREATE INDEX IF NOT EXISTS idx_correction_resubmissions_created_at
  ON correction_resubmissions (created_at);

CREATE OR REPLACE FUNCTION trg_correction_resubmission_immutable_identity()
RETURNS trigger AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.original_external_submission_id IS DISTINCT FROM OLD.original_external_submission_id
    OR NEW.original_decision_id IS DISTINCT FROM OLD.original_decision_id
    OR NEW.original_submission_package_id IS DISTINCT FROM OLD.original_submission_package_id
    OR NEW.original_assessment_cycle_id IS DISTINCT FROM OLD.original_assessment_cycle_id
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'correction resubmission identity fields are immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS correction_resubmissions_immutable_identity
  ON correction_resubmissions;
CREATE TRIGGER correction_resubmissions_immutable_identity
BEFORE UPDATE ON correction_resubmissions
FOR EACH ROW
EXECUTE FUNCTION trg_correction_resubmission_immutable_identity();

DROP TRIGGER IF EXISTS correction_resubmissions_00_set_updated_at
  ON correction_resubmissions;
CREATE TRIGGER correction_resubmissions_00_set_updated_at
BEFORE UPDATE ON correction_resubmissions
FOR EACH ROW
EXECUTE FUNCTION trg_set_updated_at();
