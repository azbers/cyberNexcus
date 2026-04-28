-- 0018_evidence_storage_metadata_correction.sql
-- Correct Phase 6 evidence storage metadata to key-only local storage.

ALTER TABLE assessment_evidence_files
  ADD COLUMN IF NOT EXISTS storage_backend TEXT NOT NULL DEFAULT 'LOCAL';

ALTER TABLE assessment_evidence_files
  ADD COLUMN IF NOT EXISTS validation_result_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE assessment_evidence_files
  DROP CONSTRAINT IF EXISTS chk_assessment_evidence_storage_backend;

ALTER TABLE assessment_evidence_files
  ADD CONSTRAINT chk_assessment_evidence_storage_backend
  CHECK (storage_backend IN ('LOCAL'));

ALTER TABLE assessment_evidence_files
  DROP COLUMN IF EXISTS storage_path;
