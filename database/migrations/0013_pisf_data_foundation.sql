-- 0013_pisf_data_foundation.sql
-- Phase 4: PISF data foundation

CREATE TABLE IF NOT EXISTS pisf_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_file_name TEXT NOT NULL,
  source_checksum TEXT NOT NULL CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('STARTED', 'COMPLETED', 'FAILED', 'SKIPPED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(summary_json) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_pisf_import_batches_checksum_status
  ON pisf_import_batches (source_checksum, status);

CREATE INDEX IF NOT EXISTS idx_pisf_import_batches_started_at
  ON pisf_import_batches (started_at DESC);

CREATE TABLE IF NOT EXISTS pisf_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  deprecated_at TIMESTAMPTZ,
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  last_import_batch_id UUID REFERENCES pisf_import_batches(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(btrim(domain_code)) > 0),
  CHECK (length(btrim(name)) > 0),
  CHECK (
    (is_active = TRUE AND deprecated_at IS NULL)
    OR
    (is_active = FALSE AND deprecated_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_pisf_domains_is_active
  ON pisf_domains (is_active);

CREATE INDEX IF NOT EXISTS idx_pisf_domains_last_import_batch
  ON pisf_domains (last_import_batch_id);

CREATE TABLE IF NOT EXISTS pisf_controls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID NOT NULL REFERENCES pisf_domains(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  control_code TEXT NOT NULL UNIQUE,
  phase TEXT NOT NULL,
  area TEXT NOT NULL,
  sub_area TEXT NOT NULL,
  title TEXT NOT NULL,
  statement_text TEXT NOT NULL,
  source_statement_text TEXT NOT NULL,
  raw_source_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  deprecated_at TIMESTAMPTZ,
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  last_import_batch_id UUID REFERENCES pisf_import_batches(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(btrim(control_code)) > 0),
  CHECK (length(btrim(phase)) > 0),
  CHECK (length(btrim(area)) > 0),
  CHECK (length(btrim(sub_area)) > 0),
  CHECK (length(btrim(title)) > 0),
  CHECK (length(btrim(statement_text)) > 0),
  CHECK (length(btrim(source_statement_text)) > 0),
  CHECK (jsonb_typeof(raw_source_json) = 'object'),
  CHECK (
    (is_active = TRUE AND deprecated_at IS NULL)
    OR
    (is_active = FALSE AND deprecated_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_pisf_controls_domain_id
  ON pisf_controls (domain_id);

CREATE INDEX IF NOT EXISTS idx_pisf_controls_phase
  ON pisf_controls (phase);

CREATE INDEX IF NOT EXISTS idx_pisf_controls_is_active
  ON pisf_controls (is_active);

CREATE INDEX IF NOT EXISTS idx_pisf_controls_last_import_batch
  ON pisf_controls (last_import_batch_id);

CREATE INDEX IF NOT EXISTS idx_pisf_controls_title_ci
  ON pisf_controls (lower(title));

CREATE INDEX IF NOT EXISTS idx_pisf_controls_statement_ci
  ON pisf_controls (lower(statement_text));

CREATE TABLE IF NOT EXISTS pisf_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  control_id UUID NOT NULL REFERENCES pisf_controls(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  requirement_key TEXT NOT NULL UNIQUE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  requirement_text TEXT NOT NULL,
  source_control_text TEXT NOT NULL,
  source_fragment TEXT,
  derivation_method TEXT NOT NULL CHECK (
    derivation_method IN ('deterministic_split', 'single_statement', 'manual_review_required')
  ),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'NEEDS_REVIEW', 'DEPRECATED')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  deprecated_at TIMESTAMPTZ,
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  last_import_batch_id UUID REFERENCES pisf_import_batches(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(btrim(requirement_key)) > 0),
  CHECK (length(btrim(requirement_text)) > 0),
  CHECK (length(btrim(source_control_text)) > 0),
  CHECK (
    (is_active = TRUE AND deprecated_at IS NULL)
    OR
    (is_active = FALSE AND deprecated_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pisf_requirements_control_ordinal
  ON pisf_requirements (control_id, ordinal);

CREATE INDEX IF NOT EXISTS idx_pisf_requirements_control_id
  ON pisf_requirements (control_id);

CREATE INDEX IF NOT EXISTS idx_pisf_requirements_status
  ON pisf_requirements (status);

CREATE INDEX IF NOT EXISTS idx_pisf_requirements_is_active
  ON pisf_requirements (is_active);

CREATE INDEX IF NOT EXISTS idx_pisf_requirements_last_import_batch
  ON pisf_requirements (last_import_batch_id);

CREATE INDEX IF NOT EXISTS idx_pisf_requirements_text_ci
  ON pisf_requirements (lower(requirement_text));

CREATE TABLE IF NOT EXISTS pisf_import_review_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id UUID NOT NULL REFERENCES pisf_import_batches(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  source_control_code TEXT NOT NULL,
  issue_type TEXT NOT NULL,
  message TEXT NOT NULL,
  raw_source_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(btrim(source_control_code)) > 0),
  CHECK (length(btrim(issue_type)) > 0),
  CHECK (length(btrim(message)) > 0),
  CHECK (jsonb_typeof(raw_source_json) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_pisf_import_review_items_batch
  ON pisf_import_review_items (import_batch_id);

CREATE INDEX IF NOT EXISTS idx_pisf_import_review_items_control_code
  ON pisf_import_review_items (source_control_code);

DROP TRIGGER IF EXISTS pisf_domains_set_updated_at ON pisf_domains;
CREATE TRIGGER pisf_domains_set_updated_at
BEFORE UPDATE ON pisf_domains
FOR EACH ROW
EXECUTE FUNCTION trg_set_updated_at();

DROP TRIGGER IF EXISTS pisf_controls_set_updated_at ON pisf_controls;
CREATE TRIGGER pisf_controls_set_updated_at
BEFORE UPDATE ON pisf_controls
FOR EACH ROW
EXECUTE FUNCTION trg_set_updated_at();

DROP TRIGGER IF EXISTS pisf_requirements_set_updated_at ON pisf_requirements;
CREATE TRIGGER pisf_requirements_set_updated_at
BEFORE UPDATE ON pisf_requirements
FOR EACH ROW
EXECUTE FUNCTION trg_set_updated_at();
