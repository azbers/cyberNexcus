-- 0036_correction_execution_foundation.sql
-- Phase 15: correction execution cycle foundation and corrected assessment cycle source metadata.

ALTER TABLE assessment_cycles
  ADD COLUMN IF NOT EXISTS cycle_type TEXT NOT NULL DEFAULT 'NORMAL';

ALTER TABLE assessment_cycles
  ADD COLUMN IF NOT EXISTS source_correction_resubmission_id UUID NULL;

ALTER TABLE assessment_cycles
  ADD COLUMN IF NOT EXISTS source_assessment_cycle_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'assessment_cycles'::regclass
      AND conname = 'fk_assessment_cycles_source_correction_resubmission'
  ) THEN
    ALTER TABLE assessment_cycles
      ADD CONSTRAINT fk_assessment_cycles_source_correction_resubmission
      FOREIGN KEY (source_correction_resubmission_id)
      REFERENCES correction_resubmissions(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'assessment_cycles'::regclass
      AND conname = 'fk_assessment_cycles_source_assessment_cycle'
  ) THEN
    ALTER TABLE assessment_cycles
      ADD CONSTRAINT fk_assessment_cycles_source_assessment_cycle
      FOREIGN KEY (source_assessment_cycle_id)
      REFERENCES assessment_cycles(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE assessment_cycles
  DROP CONSTRAINT IF EXISTS chk_assessment_cycles_cycle_type;
ALTER TABLE assessment_cycles
  ADD CONSTRAINT chk_assessment_cycles_cycle_type
  CHECK (cycle_type IN ('NORMAL', 'CORRECTION'));

ALTER TABLE assessment_cycles
  DROP CONSTRAINT IF EXISTS chk_assessment_cycles_source_consistency;
ALTER TABLE assessment_cycles
  ADD CONSTRAINT chk_assessment_cycles_source_consistency
  CHECK (
    (
      cycle_type = 'NORMAL'
      AND source_correction_resubmission_id IS NULL
      AND source_assessment_cycle_id IS NULL
    )
    OR (
      cycle_type = 'CORRECTION'
      AND source_correction_resubmission_id IS NOT NULL
      AND source_assessment_cycle_id IS NOT NULL
    )
  );

DROP INDEX IF EXISTS uq_assessment_cycles_one_draft_per_org;
CREATE UNIQUE INDEX IF NOT EXISTS uq_assessment_cycles_one_normal_draft_per_org
  ON assessment_cycles (org_id)
  WHERE status = 'DRAFT' AND cycle_type = 'NORMAL';

CREATE INDEX IF NOT EXISTS idx_assessment_cycles_cycle_type
  ON assessment_cycles (cycle_type);

CREATE INDEX IF NOT EXISTS idx_assessment_cycles_source_correction
  ON assessment_cycles (source_correction_resubmission_id);

CREATE INDEX IF NOT EXISTS idx_assessment_cycles_source_cycle
  ON assessment_cycles (source_assessment_cycle_id);

CREATE TABLE IF NOT EXISTS correction_execution_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  org_id UUID NOT NULL
    REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  correction_resubmission_id UUID NOT NULL
    REFERENCES correction_resubmissions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  original_assessment_cycle_id UUID NOT NULL
    REFERENCES assessment_cycles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  correction_assessment_cycle_id UUID NOT NULL UNIQUE
    REFERENCES assessment_cycles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  status TEXT NOT NULL CHECK (status IN ('CREATED', 'VOIDED')),

  created_by_user_id UUID NOT NULL
    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  voided_by_user_id UUID NULL
    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  voided_at TIMESTAMPTZ NULL,
  void_reason TEXT NULL,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (
    (
      status = 'CREATED'
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

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_correction_execution_per_correction
  ON correction_execution_cycles (correction_resubmission_id)
  WHERE status = 'CREATED';

CREATE INDEX IF NOT EXISTS idx_correction_execution_cycles_org
  ON correction_execution_cycles (org_id);

CREATE INDEX IF NOT EXISTS idx_correction_execution_cycles_correction_resubmission
  ON correction_execution_cycles (correction_resubmission_id);

CREATE INDEX IF NOT EXISTS idx_correction_execution_cycles_original_cycle
  ON correction_execution_cycles (original_assessment_cycle_id);

CREATE INDEX IF NOT EXISTS idx_correction_execution_cycles_correction_cycle
  ON correction_execution_cycles (correction_assessment_cycle_id);

CREATE INDEX IF NOT EXISTS idx_correction_execution_cycles_status
  ON correction_execution_cycles (status);

CREATE INDEX IF NOT EXISTS idx_correction_execution_cycles_created_at
  ON correction_execution_cycles (created_at);

CREATE OR REPLACE FUNCTION trg_correction_execution_cycle_immutable_identity()
RETURNS trigger AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.correction_resubmission_id IS DISTINCT FROM OLD.correction_resubmission_id
    OR NEW.original_assessment_cycle_id IS DISTINCT FROM OLD.original_assessment_cycle_id
    OR NEW.correction_assessment_cycle_id IS DISTINCT FROM OLD.correction_assessment_cycle_id
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'correction execution cycle identity fields are immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS correction_execution_cycles_immutable_identity
  ON correction_execution_cycles;
CREATE TRIGGER correction_execution_cycles_immutable_identity
BEFORE UPDATE ON correction_execution_cycles
FOR EACH ROW
EXECUTE FUNCTION trg_correction_execution_cycle_immutable_identity();

DROP TRIGGER IF EXISTS correction_execution_cycles_00_set_updated_at
  ON correction_execution_cycles;
CREATE TRIGGER correction_execution_cycles_00_set_updated_at
BEFORE UPDATE ON correction_execution_cycles
FOR EACH ROW
EXECUTE FUNCTION trg_set_updated_at();
