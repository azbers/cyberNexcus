-- 0002_auth_guards.sql
-- Guard triggers and append-only protections

CREATE OR REPLACE FUNCTION trg_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organizations_set_updated_at ON organizations;
CREATE TRIGGER organizations_set_updated_at
BEFORE UPDATE ON organizations
FOR EACH ROW
EXECUTE FUNCTION trg_set_updated_at();

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION trg_set_updated_at();

DROP TRIGGER IF EXISTS auth_sessions_set_updated_at ON auth_sessions;
CREATE TRIGGER auth_sessions_set_updated_at
BEFORE UPDATE ON auth_sessions
FOR EACH ROW
EXECUTE FUNCTION trg_set_updated_at();

CREATE OR REPLACE FUNCTION trg_validate_auth_session_org_and_family()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_org_id UUID;
  v_replaced_user_id UUID;
  v_replaced_family_id UUID;
BEGIN
  SELECT org_id INTO v_user_org_id FROM users WHERE id = NEW.user_id;
  IF v_user_org_id IS NULL THEN
    RAISE EXCEPTION 'auth_sessions.user_id % does not exist', NEW.user_id USING ERRCODE = '23503';
  END IF;

  IF NEW.org_id <> v_user_org_id THEN
    RAISE EXCEPTION 'auth_sessions.org_id % must match users.org_id %', NEW.org_id, v_user_org_id USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM auth_sessions s
    WHERE s.session_family_id = NEW.session_family_id
      AND s.user_id <> NEW.user_id
  ) THEN
    RAISE EXCEPTION 'session_family_id % cannot span multiple users', NEW.session_family_id USING ERRCODE = '23514';
  END IF;

  IF NEW.replaced_by_session_id IS NOT NULL THEN
    SELECT s.user_id, s.session_family_id
      INTO v_replaced_user_id, v_replaced_family_id
    FROM auth_sessions s
    WHERE s.id = NEW.replaced_by_session_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'replaced_by_session_id % does not exist', NEW.replaced_by_session_id USING ERRCODE = '23503';
    END IF;

    IF v_replaced_user_id <> NEW.user_id OR v_replaced_family_id <> NEW.session_family_id THEN
      RAISE EXCEPTION 'replaced_by_session_id must reference same user and session family' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auth_sessions_validate_org_and_family ON auth_sessions;
CREATE TRIGGER auth_sessions_validate_org_and_family
BEFORE INSERT OR UPDATE ON auth_sessions
FOR EACH ROW
EXECUTE FUNCTION trg_validate_auth_session_org_and_family();

CREATE OR REPLACE FUNCTION trg_validate_email_token_org_match()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_org_id UUID;
BEGIN
  SELECT org_id INTO v_user_org_id FROM users WHERE id = NEW.user_id;
  IF v_user_org_id IS NULL THEN
    RAISE EXCEPTION 'email_verification_tokens.user_id % does not exist', NEW.user_id USING ERRCODE = '23503';
  END IF;

  IF NEW.org_id <> v_user_org_id THEN
    RAISE EXCEPTION 'email_verification_tokens.org_id % must match users.org_id %', NEW.org_id, v_user_org_id USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS email_verification_tokens_validate_org_match ON email_verification_tokens;
CREATE TRIGGER email_verification_tokens_validate_org_match
BEFORE INSERT OR UPDATE ON email_verification_tokens
FOR EACH ROW
EXECUTE FUNCTION trg_validate_email_token_org_match();

CREATE OR REPLACE FUNCTION trg_block_auth_audit_logs_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'auth_audit_logs is append-only; % is not allowed', TG_OP USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS auth_audit_logs_block_update ON auth_audit_logs;
CREATE TRIGGER auth_audit_logs_block_update
BEFORE UPDATE ON auth_audit_logs
FOR EACH ROW
EXECUTE FUNCTION trg_block_auth_audit_logs_mutation();

DROP TRIGGER IF EXISTS auth_audit_logs_block_delete ON auth_audit_logs;
CREATE TRIGGER auth_audit_logs_block_delete
BEFORE DELETE ON auth_audit_logs
FOR EACH ROW
EXECUTE FUNCTION trg_block_auth_audit_logs_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON auth_audit_logs FROM PUBLIC;
