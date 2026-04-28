import type { PoolClient } from "pg";

import { AUTH_ERRORS } from "./errors.js";
import {
  AUDIT_EVENT_TYPES,
  AUDIT_SEVERITIES,
  type AuditEventType,
  type AuditSeverity,
  type EpochBumpRequestStatus,
  type OrgStatus,
  type RateLimitDecision,
} from "./types.js";

type LoginCandidate = {
  user_id: string;
  org_id: string;
  email: string;
  password_hash: string;
  role: string;
  token_version: number;
  email_verified: boolean;
  failed_attempts: number;
  locked_until: Date | null;
  deactivated_at: Date | null;
  org_status: OrgStatus;
};

type ActiveSession = {
  id: string;
  user_id: string;
  org_id: string;
  session_family_id: string;
  issued_at: Date;
  last_used_at: Date;
  revoked_at: Date | null;
};

type RefreshSession = {
  id: string;
  user_id: string;
  org_id: string;
  session_family_id: string;
  refresh_token_hash: string;
  device_context_hash: string | null;
  user_agent: string | null;
  ip_address: string | null;
  issued_at: Date;
  revoked_at: Date | null;
  replaced_by_session_id: string | null;
  absolute_expires_at: Date;
  idle_expires_at: Date;
  last_used_at: Date;
  user_token_version: number;
  email_verified: boolean;
  user_deactivated_at: Date | null;
  org_status: OrgStatus;
  token_epoch: Date;
  sensitive_reauth_required: boolean;
};

type SessionAuthContext = {
  session_id: string;
  user_id: string;
  org_id: string;
  user_role: string;
  session_family_id: string;
  absolute_expires_at: Date;
  idle_expires_at: Date;
  revoked_at: Date | null;
  user_token_version: number;
  email_verified: boolean;
  user_deactivated_at: Date | null;
  org_status: OrgStatus;
  token_epoch: Date;
  sensitive_reauth_required: boolean;
};

type UserProfile = {
  user_id: string;
  org_id: string;
  email: string;
  role: string;
  token_version: number;
  email_verified: boolean;
  org_status: OrgStatus;
};

type CreateOrganizationInput = {
  name: string;
  status: OrgStatus;
};

type CreateUserInput = {
  orgId: string;
  email: string;
  passwordHash: string;
  role: string;
  emailVerified: boolean;
};

type InsertSessionInput = {
  id: string;
  userId: string;
  orgId: string;
  sessionFamilyId: string;
  refreshTokenHash: string;
  deviceContextHash: string;
  userAgent: string | null;
  ipAddress: string | null;
  issuedAt: Date;
  lastUsedAt: Date;
  absoluteExpiresAt: Date;
  idleExpiresAt: Date;
};

type AuditEventInput = {
  eventType: AuditEventType;
  severity: AuditSeverity;
  userId: string | null;
  orgId: string | null;
  sessionId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
};

type RateLimitCounterInput = {
  counterKey: string;
  windowSeconds: number;
  limit: number;
  now: Date;
};

type AuditDedupInput = {
  dedupKey: string;
  windowSeconds: number;
  now: Date;
  shardCount?: number;
};

type BehaviorBucketInput = {
  sessionId: string;
  now: Date;
  refreshDelta: number;
  deviceMismatchDelta: number;
  ipChurnDelta: number;
};

type BehaviorMetrics = {
  refresh_1m: number;
  refresh_5m: number;
  mismatch_30m: number;
  ip_churn_30m: number;
};

type RiskState = {
  session_id: string;
  risk_score: number;
  transient_risk_score: number;
  persistent_risk_score: number;
  confidence_score: number;
  effective_risk_score: number;
  risk_level: "LOW" | "MEDIUM" | "HIGH";
  sensitive_reauth_required: boolean;
  baseline_refresh_interval_seconds: number | null;
  baseline_confidence: number;
  last_refresh_at: Date | null;
  last_decay_at: Date | null;
  last_anomaly_at: Date | null;
  anomaly_reasons: Record<string, unknown>;
};

type SaveRiskStateInput = {
  sessionId: string;
  riskScore: number;
  transientRiskScore: number;
  persistentRiskScore: number;
  confidenceScore: number;
  effectiveRiskScore: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  sensitiveReauthRequired: boolean;
  baselineRefreshIntervalSeconds: number | null;
  baselineConfidence: number;
  lastRefreshAt: Date | null;
  lastDecayAt: Date | null;
  lastAnomalyAt: Date | null;
  anomalyReasons: Record<string, unknown>;
};

type EpochBumpResult = {
  previousEpoch: Date;
  newEpoch: Date;
  bumpedAt: Date;
};

type CreateEpochBumpRequestInput = {
  requesterUserId: string;
  requesterSessionId: string;
  requesterContextHash: string;
  reason: string;
  confirmationTokenHash: string;
  requestedAt: Date;
  expiresAt: Date;
};

type EpochBumpRequestRecord = {
  id: string;
  requester_user_id: string;
  requester_session_id: string | null;
  requester_context_hash: string | null;
  reason: string;
  confirmation_token_hash: string;
  status: EpochBumpRequestStatus;
  requested_at: Date;
  expires_at: Date;
  confirmed_at: Date | null;
  confirmed_by_user_id: string | null;
  canceled_at: Date | null;
};

type EpochBumpImpact = {
  affected_sessions: number;
  affected_users: number;
  affected_orgs: number;
};

function assertTx(tx?: PoolClient): PoolClient {
  if (!tx) {
    throw AUTH_ERRORS.MISSING_TX_CONTEXT();
  }
  return tx;
}

function validateAuditPayload(event: AuditEventInput): void {
  if (!AUDIT_EVENT_TYPES.includes(event.eventType)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
  if (!AUDIT_SEVERITIES.includes(event.severity)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
}

function toBucketStart(now: Date, windowSeconds: number): Date {
  const windowMs = Math.max(windowSeconds, 1) * 1000;
  const bucketStart = Math.floor(now.getTime() / windowMs) * windowMs;
  return new Date(bucketStart);
}

function asNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number(value);
  }
  return 0;
}

function computeShardId(
  dedupKey: string,
  bucketStart: Date,
  shardCount: number,
): number {
  const safeShardCount = Math.max(1, shardCount);
  const input = `${dedupKey}|${bucketStart.toISOString()}`;
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % safeShardCount;
}

export class AuthRepository {
  public async createOrganization(
    tx: PoolClient | undefined,
    input: CreateOrganizationInput,
  ): Promise<{ id: string; status: OrgStatus }> {
    const client = assertTx(tx);
    const result = await client.query<{ id: string; status: OrgStatus }>(
      `
      INSERT INTO organizations (name, status)
      VALUES ($1, $2)
      RETURNING id, status
      `,
      [input.name, input.status],
    );
    return result.rows[0];
  }

  public async createUser(
    tx: PoolClient | undefined,
    input: CreateUserInput,
  ): Promise<{ id: string; org_id: string; token_version: number }> {
    const client = assertTx(tx);
    const result = await client.query<{
      id: string;
      org_id: string;
      token_version: number;
    }>(
      `
      INSERT INTO users (org_id, email, password_hash, role, email_verified)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, org_id, token_version
      `,
      [input.orgId, input.email, input.passwordHash, input.role, input.emailVerified],
    );
    return result.rows[0];
  }

  public async insertPasswordHistory(
    tx: PoolClient | undefined,
    userId: string,
    passwordHash: string,
  ): Promise<void> {
    const client = assertTx(tx);
    await client.query(
      `
      INSERT INTO password_history (user_id, password_hash)
      VALUES ($1, $2)
      `,
      [userId, passwordHash],
    );
  }

  public async findLoginCandidateForUpdate(
    tx: PoolClient | undefined,
    orgId: string,
    email: string,
  ): Promise<LoginCandidate | null> {
    const client = assertTx(tx);
    const result = await client.query<LoginCandidate>(
      `
      SELECT
        u.id AS user_id,
        u.org_id,
        u.email,
        u.password_hash,
        u.role,
        u.token_version,
        u.email_verified,
        u.failed_attempts,
        u.locked_until,
        u.deactivated_at,
        o.status AS org_status
      FROM users u
      JOIN organizations o ON o.id = u.org_id
      WHERE u.org_id = $1
        AND lower(u.email) = lower($2)
      FOR UPDATE
      `,
      [orgId, email],
    );
    return result.rows[0] ?? null;
  }

  public async lockActiveSessionsForUser(
    tx: PoolClient | undefined,
    userId: string,
  ): Promise<ActiveSession[]> {
    const client = assertTx(tx);
    const result = await client.query<ActiveSession>(
      `
      SELECT
        id,
        user_id,
        org_id,
        session_family_id,
        issued_at,
        last_used_at,
        revoked_at
      FROM auth_sessions
      WHERE user_id = $1
        AND revoked_at IS NULL
      ORDER BY issued_at ASC
      FOR UPDATE
      `,
      [userId],
    );
    return result.rows;
  }

  public async revokeSessionsByIds(
    tx: PoolClient | undefined,
    sessionIds: string[],
    reason: string,
  ): Promise<number> {
    if (sessionIds.length === 0) {
      return 0;
    }
    const client = assertTx(tx);
    const result = await client.query(
      `
      UPDATE auth_sessions
      SET revoked_at = now(),
          revoke_reason = $2
      WHERE id = ANY($1::uuid[])
        AND revoked_at IS NULL
      `,
      [sessionIds, reason],
    );
    return result.rowCount ?? 0;
  }

  public async findSessionForRefreshUpdate(
    tx: PoolClient | undefined,
    refreshTokenHash: string,
  ): Promise<RefreshSession | null> {
    const client = assertTx(tx);
    const result = await client.query<RefreshSession>(
      `
      SELECT
        s.id,
        s.user_id,
        s.org_id,
        s.session_family_id,
        s.refresh_token_hash,
        s.device_context_hash,
        s.user_agent,
        host(s.ip_address) AS ip_address,
        s.issued_at,
        s.revoked_at,
        s.replaced_by_session_id,
        s.absolute_expires_at,
        s.idle_expires_at,
        s.last_used_at,
        u.token_version AS user_token_version,
        u.email_verified,
        u.deactivated_at AS user_deactivated_at,
        o.status AS org_status,
        sec.token_epoch,
        COALESCE(risk.sensitive_reauth_required, FALSE) AS sensitive_reauth_required
      FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
      JOIN organizations o ON o.id = s.org_id
      CROSS JOIN system_security_state sec
      LEFT JOIN auth_session_risk_state risk ON risk.session_id = s.id
      WHERE s.refresh_token_hash = $1
      FOR UPDATE OF s
      `,
      [refreshTokenHash],
    );
    return result.rows[0] ?? null;
  }

  public async insertSession(
    tx: PoolClient | undefined,
    input: InsertSessionInput,
  ): Promise<{ id: string }> {
    const client = assertTx(tx);
    const result = await client.query<{ id: string }>(
      `
      INSERT INTO auth_sessions (
        id,
        user_id,
        org_id,
        session_family_id,
        refresh_token_hash,
        device_context_hash,
        user_agent,
        ip_address,
        issued_at,
        last_used_at,
        absolute_expires_at,
        idle_expires_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8::inet, $9, $10, $11, $12
      )
      RETURNING id
      `,
      [
        input.id,
        input.userId,
        input.orgId,
        input.sessionFamilyId,
        input.refreshTokenHash,
        input.deviceContextHash,
        input.userAgent,
        input.ipAddress,
        input.issuedAt,
        input.lastUsedAt,
        input.absoluteExpiresAt,
        input.idleExpiresAt,
      ],
    );
    return result.rows[0];
  }

  public async markSessionRotated(
    tx: PoolClient | undefined,
    sessionId: string,
    replacedBySessionId: string,
  ): Promise<void> {
    const client = assertTx(tx);
    const result = await client.query(
      `
      UPDATE auth_sessions
      SET rotated_at = now(),
          revoked_at = now(),
          revoke_reason = 'ROTATED',
          replaced_by_session_id = $2
      WHERE id = $1
        AND revoked_at IS NULL
      `,
      [sessionId, replacedBySessionId],
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new Error("Rotation failed; source session not active");
    }
  }

  public async touchSessionUsage(
    tx: PoolClient | undefined,
    sessionId: string,
    userAgent: string | null,
    ipAddress: string | null,
  ): Promise<void> {
    const client = assertTx(tx);
    await client.query(
      `
      UPDATE auth_sessions
      SET last_used_at = now(),
          user_agent = $2,
          ip_address = $3::inet
      WHERE id = $1
      `,
      [sessionId, userAgent, ipAddress],
    );
  }

  public async revokeSessionFamily(
    tx: PoolClient | undefined,
    userId: string,
    familyId: string,
    reason: string,
  ): Promise<number> {
    const client = assertTx(tx);
    const result = await client.query(
      `
      UPDATE auth_sessions
      SET revoked_at = now(),
          revoke_reason = $3
      WHERE user_id = $1
        AND session_family_id = $2
        AND revoked_at IS NULL
      `,
      [userId, familyId, reason],
    );
    return result.rowCount ?? 0;
  }

  public async revokeSessionById(
    tx: PoolClient | undefined,
    sessionId: string,
    reason: string,
  ): Promise<number> {
    const client = assertTx(tx);
    const result = await client.query(
      `
      UPDATE auth_sessions
      SET revoked_at = now(),
          revoke_reason = $2
      WHERE id = $1
        AND revoked_at IS NULL
      `,
      [sessionId, reason],
    );
    return result.rowCount ?? 0;
  }

  public async revokeAllSessionsForUser(
    tx: PoolClient | undefined,
    userId: string,
    reason: string,
  ): Promise<number> {
    const client = assertTx(tx);
    const result = await client.query(
      `
      UPDATE auth_sessions
      SET revoked_at = now(),
          revoke_reason = $2
      WHERE user_id = $1
        AND revoked_at IS NULL
      `,
      [userId, reason],
    );
    return result.rowCount ?? 0;
  }

  public async incrementTokenVersion(
    tx: PoolClient | undefined,
    userId: string,
  ): Promise<number> {
    const client = assertTx(tx);
    const result = await client.query<{ token_version: number }>(
      `
      UPDATE users
      SET token_version = token_version + 1
      WHERE id = $1
      RETURNING token_version
      `,
      [userId],
    );
    return result.rows[0].token_version;
  }

  public async consumeRateLimitCounter(
    tx: PoolClient | undefined,
    input: RateLimitCounterInput,
  ): Promise<RateLimitDecision> {
    const client = assertTx(tx);
    const bucketStart = toBucketStart(input.now, input.windowSeconds);
    const result = await client.query<{ request_count: number }>(
      `
      INSERT INTO auth_rate_limit_counters (counter_key, bucket_start, request_count, updated_at)
      VALUES ($1, $2, 1, now())
      ON CONFLICT (counter_key, bucket_start)
      DO UPDATE
      SET request_count = auth_rate_limit_counters.request_count + 1,
          updated_at = now()
      RETURNING request_count
      `,
      [input.counterKey, bucketStart],
    );

    const currentCount = asNumber(result.rows[0].request_count);
    return {
      blocked: currentCount > input.limit,
      blockedUntil: new Date(bucketStart.getTime() + input.windowSeconds * 1000),
      currentCount,
    };
  }

  public async upsertAuditDedupCounter(
    tx: PoolClient | undefined,
    input: AuditDedupInput,
  ): Promise<number> {
    const client = assertTx(tx);
    const bucketStart = toBucketStart(input.now, input.windowSeconds);
    const shardId = computeShardId(
      input.dedupKey,
      bucketStart,
      input.shardCount ?? 16,
    );
    const result = await client.query<{ repeat_count: number }>(
      `
      INSERT INTO auth_audit_dedup_counters (
        dedup_key,
        bucket_start,
        shard_id,
        repeat_count,
        last_seen_at,
        updated_at
      )
      VALUES ($1, $2, $3, 1, now(), now())
      ON CONFLICT (dedup_key, bucket_start, shard_id)
      DO UPDATE
      SET repeat_count = auth_audit_dedup_counters.repeat_count + 1,
          last_seen_at = now(),
          updated_at = now()
      RETURNING repeat_count
      `,
      [input.dedupKey, bucketStart, shardId],
    );
    return asNumber(result.rows[0].repeat_count);
  }

  public async upsertBehaviorBucket(
    tx: PoolClient | undefined,
    input: BehaviorBucketInput,
  ): Promise<void> {
    const client = assertTx(tx);
    const bucketStart = toBucketStart(input.now, 60);
    await client.query(
      `
      INSERT INTO auth_session_behavior_buckets (
        session_id,
        bucket_start,
        refresh_count,
        device_mismatch_count,
        ip_churn_count,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, now())
      ON CONFLICT (session_id, bucket_start)
      DO UPDATE
      SET refresh_count = auth_session_behavior_buckets.refresh_count + EXCLUDED.refresh_count,
          device_mismatch_count = auth_session_behavior_buckets.device_mismatch_count + EXCLUDED.device_mismatch_count,
          ip_churn_count = auth_session_behavior_buckets.ip_churn_count + EXCLUDED.ip_churn_count,
          updated_at = now()
      `,
      [
        input.sessionId,
        bucketStart,
        input.refreshDelta,
        input.deviceMismatchDelta,
        input.ipChurnDelta,
      ],
    );
  }

  public async getBehaviorMetrics(
    tx: PoolClient | undefined,
    sessionId: string,
    now: Date,
  ): Promise<BehaviorMetrics> {
    const client = assertTx(tx);
    const oneMinute = new Date(now.getTime() - 60 * 1000);
    const fiveMinutes = new Date(now.getTime() - 5 * 60 * 1000);
    const thirtyMinutes = new Date(now.getTime() - 30 * 60 * 1000);

    const result = await client.query<{
      refresh_1m: number;
      refresh_5m: number;
      mismatch_30m: number;
      ip_churn_30m: number;
    }>(
      `
      SELECT
        COALESCE(SUM(refresh_count) FILTER (WHERE bucket_start >= $2), 0) AS refresh_1m,
        COALESCE(SUM(refresh_count) FILTER (WHERE bucket_start >= $3), 0) AS refresh_5m,
        COALESCE(SUM(device_mismatch_count) FILTER (WHERE bucket_start >= $4), 0) AS mismatch_30m,
        COALESCE(SUM(ip_churn_count) FILTER (WHERE bucket_start >= $4), 0) AS ip_churn_30m
      FROM auth_session_behavior_buckets
      WHERE session_id = $1
      `,
      [sessionId, oneMinute, fiveMinutes, thirtyMinutes],
    );

    const row = result.rows[0];
    return {
      refresh_1m: asNumber(row?.refresh_1m ?? 0),
      refresh_5m: asNumber(row?.refresh_5m ?? 0),
      mismatch_30m: asNumber(row?.mismatch_30m ?? 0),
      ip_churn_30m: asNumber(row?.ip_churn_30m ?? 0),
    };
  }

  public async getRiskStateForUpdate(
    tx: PoolClient | undefined,
    sessionId: string,
    now: Date,
  ): Promise<RiskState> {
    const client = assertTx(tx);
    await client.query(
      `
      INSERT INTO auth_session_risk_state (session_id, last_decay_at, updated_at)
      VALUES ($1, $2, now())
      ON CONFLICT (session_id) DO NOTHING
      `,
      [sessionId, now],
    );

    const result = await client.query<{
      session_id: string;
      risk_score: number;
      transient_risk_score: number;
      persistent_risk_score: number;
      confidence_score: number;
      effective_risk_score: number;
      risk_level: "LOW" | "MEDIUM" | "HIGH";
      sensitive_reauth_required: boolean;
      baseline_refresh_interval_seconds: number | null;
      baseline_confidence: number;
      last_refresh_at: Date | null;
      last_decay_at: Date | null;
      last_anomaly_at: Date | null;
      anomaly_reasons: Record<string, unknown>;
    }>(
      `
      SELECT
        session_id,
        risk_score,
        transient_risk_score,
        persistent_risk_score,
        confidence_score,
        effective_risk_score,
        risk_level,
        sensitive_reauth_required,
        baseline_refresh_interval_seconds,
        baseline_confidence,
        last_refresh_at,
        last_decay_at,
        last_anomaly_at,
        anomaly_reasons
      FROM auth_session_risk_state
      WHERE session_id = $1
      FOR UPDATE
      `,
      [sessionId],
    );

    const row = result.rows[0];
    return {
      session_id: row.session_id,
      risk_score: asNumber(row.risk_score),
      transient_risk_score: asNumber(row.transient_risk_score),
      persistent_risk_score: asNumber(row.persistent_risk_score),
      confidence_score: asNumber(row.confidence_score),
      effective_risk_score: asNumber(row.effective_risk_score),
      risk_level: row.risk_level,
      sensitive_reauth_required: row.sensitive_reauth_required,
      baseline_refresh_interval_seconds:
        row.baseline_refresh_interval_seconds === null
          ? null
          : asNumber(row.baseline_refresh_interval_seconds),
      baseline_confidence: asNumber(row.baseline_confidence),
      last_refresh_at: row.last_refresh_at,
      last_decay_at: row.last_decay_at,
      last_anomaly_at: row.last_anomaly_at,
      anomaly_reasons: row.anomaly_reasons ?? {},
    };
  }

  public async saveRiskState(
    tx: PoolClient | undefined,
    state: SaveRiskStateInput,
  ): Promise<void> {
    const client = assertTx(tx);
    await client.query(
      `
      UPDATE auth_session_risk_state
      SET
        risk_score = $2,
        transient_risk_score = $3,
        persistent_risk_score = $4,
        confidence_score = $5,
        effective_risk_score = $6,
        risk_level = $7,
        sensitive_reauth_required = $8,
        baseline_refresh_interval_seconds = $9,
        baseline_confidence = $10,
        last_refresh_at = $11,
        last_decay_at = $12,
        last_anomaly_at = $13,
        anomaly_reasons = $14::jsonb,
        updated_at = now()
      WHERE session_id = $1
      `,
      [
        state.sessionId,
        state.riskScore,
        state.transientRiskScore,
        state.persistentRiskScore,
        state.confidenceScore,
        state.effectiveRiskScore,
        state.riskLevel,
        state.sensitiveReauthRequired,
        state.baselineRefreshIntervalSeconds,
        state.baselineConfidence,
        state.lastRefreshAt,
        state.lastDecayAt,
        state.lastAnomalyAt,
        JSON.stringify(state.anomalyReasons),
      ],
    );
  }

  public async readTokenEpoch(tx: PoolClient | undefined): Promise<Date> {
    const client = assertTx(tx);
    const result = await client.query<{ token_epoch: Date }>(
      `
      SELECT token_epoch
      FROM system_security_state
      WHERE singleton = TRUE
      `,
    );
    return result.rows[0].token_epoch;
  }

  public async getEpochBumpImpact(
    tx: PoolClient | undefined,
    now: Date,
  ): Promise<EpochBumpImpact> {
    const client = assertTx(tx);
    const result = await client.query<{
      affected_sessions: number | string;
      affected_users: number | string;
      affected_orgs: number | string;
    }>(
      `
      WITH active_sessions AS (
        SELECT user_id, org_id
        FROM auth_sessions
        WHERE revoked_at IS NULL
          AND absolute_expires_at > $1
          AND idle_expires_at > $1
      )
      SELECT
        COALESCE(count(*), 0) AS affected_sessions,
        COALESCE(count(DISTINCT user_id), 0) AS affected_users,
        COALESCE(count(DISTINCT org_id), 0) AS affected_orgs
      FROM active_sessions
      `,
      [now],
    );

    const row = result.rows[0];
    return {
      affected_sessions: asNumber(row.affected_sessions),
      affected_users: asNumber(row.affected_users),
      affected_orgs: asNumber(row.affected_orgs),
    };
  }

  public async createEpochBumpRequest(
    tx: PoolClient | undefined,
    input: CreateEpochBumpRequestInput,
  ): Promise<{ id: string; expires_at: Date; requested_at: Date }> {
    const client = assertTx(tx);
    const result = await client.query<{
      id: string;
      expires_at: Date;
      requested_at: Date;
    }>(
      `
      INSERT INTO auth_token_epoch_bump_requests (
        requester_user_id,
        requester_session_id,
        requester_context_hash,
        reason,
        confirmation_token_hash,
        status,
        requested_at,
        expires_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, now())
      RETURNING id, expires_at, requested_at
      `,
      [
        input.requesterUserId,
        input.requesterSessionId,
        input.requesterContextHash,
        input.reason,
        input.confirmationTokenHash,
        input.requestedAt,
        input.expiresAt,
      ],
    );
    return result.rows[0];
  }

  public async findEpochBumpRequestForUpdate(
    tx: PoolClient | undefined,
    confirmationTokenHash: string,
  ): Promise<EpochBumpRequestRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<EpochBumpRequestRecord>(
      `
      SELECT
        id,
        requester_user_id,
        requester_session_id,
        requester_context_hash,
        reason,
        confirmation_token_hash,
        status,
        requested_at,
        expires_at,
        confirmed_at,
        confirmed_by_user_id,
        canceled_at
      FROM auth_token_epoch_bump_requests
      WHERE confirmation_token_hash = $1
      FOR UPDATE
      `,
      [confirmationTokenHash],
    );
    return result.rows[0] ?? null;
  }

  public async markEpochBumpRequestConfirmed(
    tx: PoolClient | undefined,
    requestId: string,
    confirmedByUserId: string,
    confirmedAt: Date,
  ): Promise<void> {
    const client = assertTx(tx);
    const result = await client.query(
      `
      UPDATE auth_token_epoch_bump_requests
      SET status = 'CONFIRMED',
          confirmed_at = $2,
          confirmed_by_user_id = $3,
          updated_at = now()
      WHERE id = $1
        AND status = 'PENDING'
      `,
      [requestId, confirmedAt, confirmedByUserId],
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new Error("Epoch bump request was not pending");
    }
  }

  public async markEpochBumpRequestExpired(
    tx: PoolClient | undefined,
    requestId: string,
  ): Promise<void> {
    const client = assertTx(tx);
    await client.query(
      `
      UPDATE auth_token_epoch_bump_requests
      SET status = 'EXPIRED',
          updated_at = now()
      WHERE id = $1
        AND status = 'PENDING'
      `,
      [requestId],
    );
  }

  public async bumpTokenEpoch(
    tx: PoolClient | undefined,
    actorUserId: string,
    reason: string,
    now: Date,
  ): Promise<EpochBumpResult> {
    const client = assertTx(tx);
    const current = await client.query<{ token_epoch: Date }>(
      `
      SELECT token_epoch
      FROM system_security_state
      WHERE singleton = TRUE
      FOR UPDATE
      `,
    );

    const previousEpoch = current.rows[0].token_epoch;
    const bumpedAt = now;
    const newEpoch =
      now.getTime() > previousEpoch.getTime()
        ? now
        : new Date(previousEpoch.getTime() + 1000);

    await client.query(
      `
      UPDATE system_security_state
      SET token_epoch = $1,
          last_bump_reason = $2,
          last_bumped_by = $3,
          last_bumped_at = $4,
          updated_at = now()
      WHERE singleton = TRUE
      `,
      [newEpoch, reason, actorUserId, bumpedAt],
    );

    await client.query(
      `
      INSERT INTO auth_token_epoch_bumps (
        actor_user_id,
        previous_epoch,
        new_epoch,
        reason,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5)
      `,
      [actorUserId, previousEpoch, newEpoch, reason, bumpedAt],
    );

    return {
      previousEpoch,
      newEpoch,
      bumpedAt,
    };
  }

  public async appendAuditEvent(
    tx: PoolClient | undefined,
    event: AuditEventInput,
  ): Promise<void> {
    validateAuditPayload(event);
    const client = assertTx(tx);
    await client.query(
      `
      INSERT INTO auth_audit_logs (
        event_type,
        severity,
        user_id,
        org_id,
        session_id,
        ip_address,
        user_agent,
        metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6::inet, $7, $8::jsonb
      )
      `,
      [
        event.eventType,
        event.severity,
        event.userId,
        event.orgId,
        event.sessionId,
        event.ipAddress,
        event.userAgent,
        JSON.stringify(event.metadata),
      ],
    );
  }

  public async findSessionAuthContext(
    tx: PoolClient | undefined,
    sessionId: string,
  ): Promise<SessionAuthContext | null> {
    const client = assertTx(tx);
    const result = await client.query<SessionAuthContext>(
      `
      SELECT
        s.id AS session_id,
        s.user_id,
        s.org_id,
        u.role AS user_role,
        s.session_family_id,
        s.absolute_expires_at,
        s.idle_expires_at,
        s.revoked_at,
        u.token_version AS user_token_version,
        u.email_verified,
        u.deactivated_at AS user_deactivated_at,
        o.status AS org_status,
        sec.token_epoch,
        COALESCE(risk.sensitive_reauth_required, FALSE) AS sensitive_reauth_required
      FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
      JOIN organizations o ON o.id = s.org_id
      CROSS JOIN system_security_state sec
      LEFT JOIN auth_session_risk_state risk ON risk.session_id = s.id
      WHERE s.id = $1
      `,
      [sessionId],
    );
    return result.rows[0] ?? null;
  }

  public async findUserProfile(
    tx: PoolClient | undefined,
    userId: string,
  ): Promise<UserProfile | null> {
    const client = assertTx(tx);
    const result = await client.query<UserProfile>(
      `
      SELECT
        u.id AS user_id,
        u.org_id,
        u.email,
        u.role,
        u.token_version,
        u.email_verified,
        o.status AS org_status
      FROM users u
      JOIN organizations o ON o.id = u.org_id
      WHERE u.id = $1
      `,
      [userId],
    );
    return result.rows[0] ?? null;
  }
}

export type {
  ActiveSession,
  AuditEventInput,
  BehaviorMetrics,
  CreateEpochBumpRequestInput,
  EpochBumpImpact,
  EpochBumpRequestRecord,
  EpochBumpResult,
  InsertSessionInput,
  LoginCandidate,
  RefreshSession,
  RiskState,
  SaveRiskStateInput,
  SessionAuthContext,
  UserProfile,
};
