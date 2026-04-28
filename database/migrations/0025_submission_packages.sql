-- 0025_submission_packages.sql
-- Phase 10: immutable external submission package metadata.

CREATE TABLE IF NOT EXISTS assessment_submission_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL
    REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  assessment_cycle_id UUID NOT NULL
    REFERENCES assessment_cycles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  score_snapshot_id UUID NOT NULL
    REFERENCES assessment_score_snapshots(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  readiness_id UUID NOT NULL
    REFERENCES assessment_submission_readiness(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  package_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('CREATED', 'VOIDED')),

  manifest_json JSONB NOT NULL,
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),

  created_by_user_id UUID NOT NULL
    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  voided_by_user_id UUID
    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  voided_at TIMESTAMPTZ,
  void_reason TEXT,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (length(btrim(package_number)) > 0),
  CHECK (
    (
      status = 'CREATED'
      AND voided_by_user_id IS NULL
      AND voided_at IS NULL
      AND void_reason IS NULL
    )
    OR
    (
      status = 'VOIDED'
      AND voided_by_user_id IS NOT NULL
      AND voided_at IS NOT NULL
      AND void_reason IS NOT NULL
      AND length(btrim(void_reason)) BETWEEN 10 AND 2000
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_submission_packages_one_created_per_cycle
  ON assessment_submission_packages (assessment_cycle_id)
  WHERE status = 'CREATED';

CREATE INDEX IF NOT EXISTS idx_submission_packages_org
  ON assessment_submission_packages (org_id);

CREATE INDEX IF NOT EXISTS idx_submission_packages_cycle
  ON assessment_submission_packages (assessment_cycle_id);

CREATE INDEX IF NOT EXISTS idx_submission_packages_package_number
  ON assessment_submission_packages (package_number);

CREATE INDEX IF NOT EXISTS idx_submission_packages_status
  ON assessment_submission_packages (status);

CREATE OR REPLACE FUNCTION trg_submission_package_immutable_fields()
RETURNS trigger AS $$
BEGIN
  IF NEW.package_number IS DISTINCT FROM OLD.package_number
    OR NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.assessment_cycle_id IS DISTINCT FROM OLD.assessment_cycle_id
    OR NEW.score_snapshot_id IS DISTINCT FROM OLD.score_snapshot_id
    OR NEW.readiness_id IS DISTINCT FROM OLD.readiness_id
    OR NEW.manifest_json IS DISTINCT FROM OLD.manifest_json
    OR NEW.manifest_hash IS DISTINCT FROM OLD.manifest_hash
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'submission package immutable fields cannot be changed'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS assessment_submission_packages_immutable_fields
  ON assessment_submission_packages;
CREATE TRIGGER assessment_submission_packages_immutable_fields
BEFORE UPDATE ON assessment_submission_packages
FOR EACH ROW
EXECUTE FUNCTION trg_submission_package_immutable_fields();

DROP TRIGGER IF EXISTS assessment_submission_packages_set_updated_at
  ON assessment_submission_packages;
CREATE TRIGGER assessment_submission_packages_set_updated_at
BEFORE UPDATE ON assessment_submission_packages
FOR EACH ROW
EXECUTE FUNCTION trg_set_updated_at();
