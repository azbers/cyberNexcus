-- 0016_assessment_evidence_foundation.sql
-- Phase 6: Evidence foundation (secure local storage metadata and soft removal).

CREATE TABLE IF NOT EXISTS assessment_evidence_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  assessment_cycle_id UUID NOT NULL REFERENCES assessment_cycles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  assessment_requirement_item_id UUID NOT NULL REFERENCES assessment_requirement_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  uploaded_by_user_id UUID NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  original_filename TEXT NOT NULL,
  stored_filename TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  storage_path TEXT NOT NULL,
  mime_type_claimed TEXT,
  mime_type_detected TEXT NOT NULL,
  file_extension TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes > 0 AND file_size_bytes <= 26214400),
  sha256_hash TEXT NOT NULL CHECK (sha256_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'UPLOADED' CHECK (status IN ('UPLOADED', 'REMOVED')),
  removed_at TIMESTAMPTZ,
  removed_by_user_id UUID REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  remove_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(btrim(original_filename)) > 0),
  CHECK (length(btrim(stored_filename)) > 0),
  CHECK (length(btrim(storage_key)) > 0),
  CHECK (length(btrim(storage_path)) > 0),
  CHECK (
    (status = 'UPLOADED' AND removed_at IS NULL AND removed_by_user_id IS NULL AND remove_reason IS NULL)
    OR
    (
      status = 'REMOVED'
      AND removed_at IS NOT NULL
      AND removed_by_user_id IS NOT NULL
      AND remove_reason IS NOT NULL
      AND length(btrim(remove_reason)) BETWEEN 10 AND 2000
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_assessment_evidence_org_cycle
  ON assessment_evidence_files (org_id, assessment_cycle_id);

CREATE INDEX IF NOT EXISTS idx_assessment_evidence_item_status
  ON assessment_evidence_files (assessment_requirement_item_id, status);

CREATE INDEX IF NOT EXISTS idx_assessment_evidence_sha256
  ON assessment_evidence_files (sha256_hash);

CREATE INDEX IF NOT EXISTS idx_assessment_evidence_uploaded_by
  ON assessment_evidence_files (uploaded_by_user_id);

DROP TRIGGER IF EXISTS assessment_evidence_files_set_updated_at ON assessment_evidence_files;
CREATE TRIGGER assessment_evidence_files_set_updated_at
BEFORE UPDATE ON assessment_evidence_files
FOR EACH ROW
EXECUTE FUNCTION trg_set_updated_at();
