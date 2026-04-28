-- 0014_assessment_foundation.sql
-- Phase 5: Assessment foundation (internal draft/update/finalize workflow)

CREATE TABLE IF NOT EXISTS assessment_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'FINALIZED_INTERNAL')),
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  finalized_internal_by_user_id UUID REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_internal_at TIMESTAMPTZ,
  CHECK (
    (status = 'DRAFT' AND finalized_internal_by_user_id IS NULL AND finalized_internal_at IS NULL)
    OR
    (status = 'FINALIZED_INTERNAL' AND finalized_internal_by_user_id IS NOT NULL AND finalized_internal_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_assessment_cycles_org_status
  ON assessment_cycles (org_id, status);

CREATE INDEX IF NOT EXISTS idx_assessment_cycles_org_created
  ON assessment_cycles (org_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_assessment_cycles_one_draft_per_org
  ON assessment_cycles (org_id)
  WHERE status = 'DRAFT';

CREATE TABLE IF NOT EXISTS assessment_requirement_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_cycle_id UUID NOT NULL REFERENCES assessment_cycles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  pisf_requirement_id UUID NOT NULL REFERENCES pisf_requirements(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  requirement_key_snapshot TEXT NOT NULL,
  requirement_text_snapshot TEXT NOT NULL,
  source_hash_snapshot TEXT NOT NULL CHECK (source_hash_snapshot ~ '^[0-9a-f]{64}$'),
  assessment_status TEXT NOT NULL CHECK (
    assessment_status IN (
      'UNASSESSED',
      'NOT_COMPLIANT',
      'PARTIALLY_COMPLIANT',
      'MOSTLY_COMPLIANT',
      'FULLY_COMPLIANT',
      'NOT_APPLICABLE'
    )
  ),
  updated_by_user_id UUID REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(btrim(requirement_key_snapshot)) > 0),
  CHECK (length(btrim(requirement_text_snapshot)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_assessment_items_cycle_requirement
  ON assessment_requirement_items (assessment_cycle_id, pisf_requirement_id);

CREATE INDEX IF NOT EXISTS idx_assessment_items_cycle
  ON assessment_requirement_items (assessment_cycle_id);

CREATE INDEX IF NOT EXISTS idx_assessment_items_cycle_status
  ON assessment_requirement_items (assessment_cycle_id, assessment_status);

CREATE INDEX IF NOT EXISTS idx_assessment_items_requirement
  ON assessment_requirement_items (pisf_requirement_id);

DROP TRIGGER IF EXISTS assessment_cycles_set_updated_at ON assessment_cycles;
CREATE TRIGGER assessment_cycles_set_updated_at
BEFORE UPDATE ON assessment_cycles
FOR EACH ROW
EXECUTE FUNCTION trg_set_updated_at();

DROP TRIGGER IF EXISTS assessment_requirement_items_set_updated_at ON assessment_requirement_items;
CREATE TRIGGER assessment_requirement_items_set_updated_at
BEFORE UPDATE ON assessment_requirement_items
FOR EACH ROW
EXECUTE FUNCTION trg_set_updated_at();
