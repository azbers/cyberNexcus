-- 0021_assessment_scoring_foundation.sql
-- Phase 8: deterministic internal assessment scoring snapshots.

CREATE TABLE IF NOT EXISTS assessment_score_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_cycle_id UUID NOT NULL UNIQUE
    REFERENCES assessment_cycles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  org_id UUID NOT NULL
    REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  scoring_version TEXT NOT NULL DEFAULT 'SCORING_V1',
  overall_score NUMERIC(5,2),
  overall_label TEXT CHECK (
    overall_label IS NULL
    OR overall_label IN (
      'NON_COMPLIANT',
      'PARTIALLY_COMPLIANT',
      'SUBSTANTIALLY_COMPLIANT',
      'COMPLIANT'
    )
  ),
  total_requirements INT NOT NULL DEFAULT 0 CHECK (total_requirements >= 0),
  applicable_requirements INT NOT NULL DEFAULT 0 CHECK (applicable_requirements >= 0),
  not_applicable_requirements INT NOT NULL DEFAULT 0 CHECK (not_applicable_requirements >= 0),
  not_compliant_count INT NOT NULL DEFAULT 0 CHECK (not_compliant_count >= 0),
  partially_compliant_count INT NOT NULL DEFAULT 0 CHECK (partially_compliant_count >= 0),
  mostly_compliant_count INT NOT NULL DEFAULT 0 CHECK (mostly_compliant_count >= 0),
  fully_compliant_count INT NOT NULL DEFAULT 0 CHECK (fully_compliant_count >= 0),
  calculated_by_user_id UUID
    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  calculated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(btrim(scoring_version)) > 0),
  CHECK (overall_score IS NULL OR (overall_score >= 0 AND overall_score <= 100))
);

CREATE INDEX IF NOT EXISTS idx_assessment_score_snapshots_org
  ON assessment_score_snapshots (org_id);

CREATE INDEX IF NOT EXISTS idx_assessment_score_snapshots_calculated_at
  ON assessment_score_snapshots (calculated_at DESC);

CREATE TABLE IF NOT EXISTS assessment_requirement_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  score_snapshot_id UUID NOT NULL
    REFERENCES assessment_score_snapshots(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  assessment_requirement_item_id UUID NOT NULL
    REFERENCES assessment_requirement_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  pisf_requirement_id UUID NOT NULL
    REFERENCES pisf_requirements(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  assessment_status TEXT NOT NULL CHECK (
    assessment_status IN (
      'NOT_COMPLIANT',
      'PARTIALLY_COMPLIANT',
      'MOSTLY_COMPLIANT',
      'FULLY_COMPLIANT',
      'NOT_APPLICABLE'
    )
  ),
  evidence_quality TEXT CHECK (
    evidence_quality IS NULL
    OR evidence_quality IN ('STRONG', 'MODERATE', 'WEAK', 'NONE')
  ),
  status_score NUMERIC(5,2) CHECK (
    status_score IS NULL OR (status_score >= 0 AND status_score <= 100)
  ),
  evidence_quality_cap NUMERIC(5,2) CHECK (
    evidence_quality_cap IS NULL
    OR (evidence_quality_cap >= 0 AND evidence_quality_cap <= 100)
  ),
  final_score NUMERIC(5,2) CHECK (
    final_score IS NULL OR (final_score >= 0 AND final_score <= 100)
  ),
  excluded BOOLEAN NOT NULL DEFAULT false,
  exclusion_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (score_snapshot_id, assessment_requirement_item_id),
  CHECK (
    (excluded = TRUE AND final_score IS NULL AND exclusion_reason IS NOT NULL)
    OR
    (excluded = FALSE AND final_score IS NOT NULL AND exclusion_reason IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_assessment_requirement_scores_snapshot
  ON assessment_requirement_scores (score_snapshot_id);

CREATE INDEX IF NOT EXISTS idx_assessment_requirement_scores_item
  ON assessment_requirement_scores (assessment_requirement_item_id);

CREATE INDEX IF NOT EXISTS idx_assessment_requirement_scores_requirement
  ON assessment_requirement_scores (pisf_requirement_id);

CREATE TABLE IF NOT EXISTS assessment_control_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  score_snapshot_id UUID NOT NULL
    REFERENCES assessment_score_snapshots(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  pisf_control_id UUID NOT NULL
    REFERENCES pisf_controls(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  control_score NUMERIC(5,2) CHECK (
    control_score IS NULL OR (control_score >= 0 AND control_score <= 100)
  ),
  applicable_requirements INT NOT NULL CHECK (applicable_requirements >= 0),
  excluded_requirements INT NOT NULL CHECK (excluded_requirements >= 0),
  total_requirements INT NOT NULL CHECK (total_requirements >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (score_snapshot_id, pisf_control_id)
);

CREATE INDEX IF NOT EXISTS idx_assessment_control_scores_snapshot
  ON assessment_control_scores (score_snapshot_id);

CREATE INDEX IF NOT EXISTS idx_assessment_control_scores_control
  ON assessment_control_scores (pisf_control_id);

DROP TRIGGER IF EXISTS assessment_score_snapshots_set_updated_at
  ON assessment_score_snapshots;
CREATE TRIGGER assessment_score_snapshots_set_updated_at
BEFORE UPDATE ON assessment_score_snapshots
FOR EACH ROW
EXECUTE FUNCTION trg_set_updated_at();
