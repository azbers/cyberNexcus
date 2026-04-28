-- 0019_assessment_evidence_checklists.sql
-- Phase 7: structured human evidence checklist per assessment requirement item.

CREATE TABLE IF NOT EXISTS assessment_evidence_checklists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  assessment_cycle_id UUID NOT NULL REFERENCES assessment_cycles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  assessment_requirement_item_id UUID NOT NULL REFERENCES assessment_requirement_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  dated_within_12_months TEXT NOT NULL
    CHECK (dated_within_12_months IN ('YES', 'NO', 'NOT_APPLICABLE')),
  organization_specific TEXT NOT NULL
    CHECK (organization_specific IN ('YES', 'NO')),
  addresses_requirement TEXT NOT NULL
    CHECK (addresses_requirement IN ('YES', 'PARTIALLY', 'NO')),
  approved_by_authority TEXT NOT NULL
    CHECK (approved_by_authority IN ('YES', 'PENDING', 'NO', 'NOT_APPLICABLE')),
  currently_in_force TEXT NOT NULL
    CHECK (currently_in_force IN ('YES', 'NO', 'NOT_APPLICABLE')),
  evidence_quality TEXT NOT NULL
    CHECK (evidence_quality IN ('STRONG', 'MODERATE', 'WEAK', 'NONE')),

  review_notes TEXT NULL CHECK (review_notes IS NULL OR length(review_notes) <= 2000),
  reviewed_by_user_id UUID NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_assessment_evidence_checklists_item
    UNIQUE (assessment_requirement_item_id)
);

CREATE INDEX IF NOT EXISTS idx_assessment_evidence_checklists_org_cycle
  ON assessment_evidence_checklists (org_id, assessment_cycle_id);

CREATE INDEX IF NOT EXISTS idx_assessment_evidence_checklists_item
  ON assessment_evidence_checklists (assessment_requirement_item_id);

CREATE INDEX IF NOT EXISTS idx_assessment_evidence_checklists_reviewer
  ON assessment_evidence_checklists (reviewed_by_user_id);

DROP TRIGGER IF EXISTS assessment_evidence_checklists_set_updated_at
  ON assessment_evidence_checklists;
CREATE TRIGGER assessment_evidence_checklists_set_updated_at
BEFORE UPDATE ON assessment_evidence_checklists
FOR EACH ROW
EXECUTE FUNCTION trg_set_updated_at();
