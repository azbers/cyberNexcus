-- 0023_submission_readiness.sql
-- Phase 9: organization-internal submission readiness and declaration workflow.

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'assessment_cycles'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE format(
      'ALTER TABLE assessment_cycles DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END $$;

ALTER TABLE assessment_cycles
  ADD CONSTRAINT chk_assessment_cycles_status
  CHECK (status IN ('DRAFT', 'FINALIZED_INTERNAL', 'READY_FOR_SUBMISSION'));

ALTER TABLE assessment_cycles
  ADD CONSTRAINT chk_assessment_cycles_finalization_consistency
  CHECK (
    (status = 'DRAFT'
      AND finalized_internal_by_user_id IS NULL
      AND finalized_internal_at IS NULL)
    OR
    (status IN ('FINALIZED_INTERNAL', 'READY_FOR_SUBMISSION')
      AND finalized_internal_by_user_id IS NOT NULL
      AND finalized_internal_at IS NOT NULL)
  );

CREATE TABLE IF NOT EXISTS assessment_submission_readiness (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL
    REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  assessment_cycle_id UUID NOT NULL UNIQUE
    REFERENCES assessment_cycles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  review_notes TEXT NULL
    CHECK (review_notes IS NULL OR length(review_notes) <= 5000),

  confirmed_assessment_complete BOOLEAN NOT NULL,
  confirmed_evidence_attached BOOLEAN NOT NULL,
  confirmed_evidence_reviewed BOOLEAN NOT NULL,
  confirmed_score_reviewed BOOLEAN NOT NULL,
  confirmed_authorized_submitter BOOLEAN NOT NULL,
  confirmed_information_accurate BOOLEAN NOT NULL,

  declaration_text TEXT NOT NULL
    CHECK (length(btrim(declaration_text)) BETWEEN 50 AND 2000),
  declared_by_user_id UUID NOT NULL
    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  declared_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_submission_readiness_org_cycle
  ON assessment_submission_readiness (org_id, assessment_cycle_id);

CREATE INDEX IF NOT EXISTS idx_submission_readiness_declared_by
  ON assessment_submission_readiness (declared_by_user_id);

DROP TRIGGER IF EXISTS assessment_submission_readiness_set_updated_at
  ON assessment_submission_readiness;
CREATE TRIGGER assessment_submission_readiness_set_updated_at
BEFORE UPDATE ON assessment_submission_readiness
FOR EACH ROW
EXECUTE FUNCTION trg_set_updated_at();
