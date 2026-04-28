-- 0029_pkcert_intake_review_queue.sql
-- Phase 12: PKCERT intake visibility and triage queue.

CREATE TABLE IF NOT EXISTS pkcert_users (
  user_id UUID PRIMARY KEY
    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  pkcert_role TEXT NOT NULL CHECK (pkcert_role IN ('PKCERT_ADMIN', 'PKCERT_REVIEWER')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pkcert_intake_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_submission_id UUID NOT NULL UNIQUE
    REFERENCES external_submissions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  org_id UUID NOT NULL
    REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  assessment_cycle_id UUID NOT NULL
    REFERENCES assessment_cycles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  submission_package_id UUID NOT NULL
    REFERENCES assessment_submission_packages(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  status TEXT NOT NULL CHECK (
    status IN ('PENDING_INTAKE', 'IN_INTAKE_REVIEW', 'INTAKE_REVIEWED')
  ),

  assigned_to_user_id UUID
    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  assigned_at TIMESTAMPTZ,

  started_by_user_id UUID
    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  started_at TIMESTAMPTZ,

  reviewed_by_user_id UUID
    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ,

  internal_notes TEXT CHECK (internal_notes IS NULL OR length(internal_notes) <= 5000),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (
    (
      status = 'PENDING_INTAKE'
      AND (
        (assigned_to_user_id IS NULL AND assigned_at IS NULL)
        OR
        (assigned_to_user_id IS NOT NULL AND assigned_at IS NOT NULL)
      )
      AND started_by_user_id IS NULL
      AND started_at IS NULL
      AND reviewed_by_user_id IS NULL
      AND reviewed_at IS NULL
    )
    OR
    (
      status = 'IN_INTAKE_REVIEW'
      AND assigned_to_user_id IS NOT NULL
      AND assigned_at IS NOT NULL
      AND started_by_user_id IS NOT NULL
      AND started_at IS NOT NULL
      AND reviewed_by_user_id IS NULL
      AND reviewed_at IS NULL
    )
    OR
    (
      status = 'INTAKE_REVIEWED'
      AND assigned_to_user_id IS NOT NULL
      AND assigned_at IS NOT NULL
      AND started_by_user_id IS NOT NULL
      AND started_at IS NOT NULL
      AND reviewed_by_user_id IS NOT NULL
      AND reviewed_at IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_pkcert_intake_reviews_status
  ON pkcert_intake_reviews (status);

CREATE INDEX IF NOT EXISTS idx_pkcert_intake_reviews_org
  ON pkcert_intake_reviews (org_id);

CREATE INDEX IF NOT EXISTS idx_pkcert_intake_reviews_external_submission
  ON pkcert_intake_reviews (external_submission_id);

CREATE INDEX IF NOT EXISTS idx_pkcert_intake_reviews_assigned_to
  ON pkcert_intake_reviews (assigned_to_user_id);

CREATE INDEX IF NOT EXISTS idx_pkcert_intake_reviews_created_at
  ON pkcert_intake_reviews (created_at);

CREATE OR REPLACE FUNCTION trg_pkcert_intake_review_immutable_identity()
RETURNS trigger AS $$
BEGIN
  IF NEW.external_submission_id IS DISTINCT FROM OLD.external_submission_id
    OR NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.assessment_cycle_id IS DISTINCT FROM OLD.assessment_cycle_id
    OR NEW.submission_package_id IS DISTINCT FROM OLD.submission_package_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'pkcert intake review immutable identity fields cannot be changed'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pkcert_users_set_updated_at
  ON pkcert_users;
CREATE TRIGGER pkcert_users_set_updated_at
BEFORE UPDATE ON pkcert_users
FOR EACH ROW
EXECUTE FUNCTION trg_set_updated_at();

DROP TRIGGER IF EXISTS pkcert_intake_reviews_immutable_identity
  ON pkcert_intake_reviews;
CREATE TRIGGER pkcert_intake_reviews_immutable_identity
BEFORE UPDATE ON pkcert_intake_reviews
FOR EACH ROW
EXECUTE FUNCTION trg_pkcert_intake_review_immutable_identity();

DROP TRIGGER IF EXISTS pkcert_intake_reviews_set_updated_at
  ON pkcert_intake_reviews;
CREATE TRIGGER pkcert_intake_reviews_set_updated_at
BEFORE UPDATE ON pkcert_intake_reviews
FOR EACH ROW
EXECUTE FUNCTION trg_set_updated_at();

INSERT INTO pkcert_intake_reviews (
  external_submission_id,
  org_id,
  assessment_cycle_id,
  submission_package_id,
  status
)
SELECT
  es.id,
  es.org_id,
  es.assessment_cycle_id,
  es.submission_package_id,
  'PENDING_INTAKE'
FROM external_submissions es
WHERE es.status = 'SUBMITTED'
  AND NOT EXISTS (
    SELECT 1
    FROM pkcert_intake_reviews pir
    WHERE pir.external_submission_id = es.id
  );
