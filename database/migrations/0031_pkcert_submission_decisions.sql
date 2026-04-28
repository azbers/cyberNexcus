-- 0031_pkcert_submission_decisions.sql
-- Phase 13: immutable PKCERT decisions for reviewed external submissions.

CREATE TABLE IF NOT EXISTS pkcert_submission_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  external_submission_id UUID NOT NULL UNIQUE
    REFERENCES external_submissions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  intake_review_id UUID NOT NULL
    REFERENCES pkcert_intake_reviews(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  org_id UUID NOT NULL
    REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  assessment_cycle_id UUID NOT NULL
    REFERENCES assessment_cycles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  submission_package_id UUID NOT NULL
    REFERENCES assessment_submission_packages(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  decision TEXT NOT NULL CHECK (
    decision IN ('ACCEPTED', 'REJECTED', 'RETURNED_FOR_CORRECTION')
  ),
  decision_reason TEXT NOT NULL CHECK (
    length(btrim(decision_reason)) BETWEEN 20 AND 5000
  ),

  decided_by_user_id UUID NOT NULL
    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pkcert_submission_decisions_org
  ON pkcert_submission_decisions (org_id);

CREATE INDEX IF NOT EXISTS idx_pkcert_submission_decisions_external_submission
  ON pkcert_submission_decisions (external_submission_id);

CREATE INDEX IF NOT EXISTS idx_pkcert_submission_decisions_intake_review
  ON pkcert_submission_decisions (intake_review_id);

CREATE INDEX IF NOT EXISTS idx_pkcert_submission_decisions_decision
  ON pkcert_submission_decisions (decision);

CREATE INDEX IF NOT EXISTS idx_pkcert_submission_decisions_decided_at
  ON pkcert_submission_decisions (decided_at);

CREATE OR REPLACE FUNCTION trg_pkcert_submission_decision_immutable()
RETURNS trigger AS $$
BEGIN
  IF NEW.external_submission_id IS DISTINCT FROM OLD.external_submission_id
    OR NEW.intake_review_id IS DISTINCT FROM OLD.intake_review_id
    OR NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.assessment_cycle_id IS DISTINCT FROM OLD.assessment_cycle_id
    OR NEW.submission_package_id IS DISTINCT FROM OLD.submission_package_id
    OR NEW.decision IS DISTINCT FROM OLD.decision
    OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason
    OR NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id
    OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
  THEN
    RAISE EXCEPTION 'pkcert submission decision records are immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pkcert_submission_decisions_immutable
  ON pkcert_submission_decisions;
CREATE TRIGGER pkcert_submission_decisions_immutable
BEFORE UPDATE ON pkcert_submission_decisions
FOR EACH ROW
EXECUTE FUNCTION trg_pkcert_submission_decision_immutable();

DROP TRIGGER IF EXISTS pkcert_submission_decisions_00_set_updated_at
  ON pkcert_submission_decisions;
CREATE TRIGGER pkcert_submission_decisions_00_set_updated_at
BEFORE UPDATE ON pkcert_submission_decisions
FOR EACH ROW
EXECUTE FUNCTION trg_set_updated_at();
