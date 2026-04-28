import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { AuthRepository } from "../src/auth/repository.js";
import { AuthService } from "../src/auth/service.js";
import { hashRefreshToken, issueTokenPair } from "../src/auth/tokens.js";

function createMockRepository(): AuthRepository {
  return {
    createOrganization: vi.fn(),
    createUser: vi.fn(),
    insertPasswordHistory: vi.fn(),
    findLoginCandidateForUpdate: vi.fn(),
    lockActiveSessionsForUser: vi.fn(),
    revokeSessionsByIds: vi.fn(),
    findSessionForRefreshUpdate: vi.fn(),
    insertSession: vi.fn(),
    markSessionRotated: vi.fn(),
    touchSessionUsage: vi.fn(),
    revokeSessionFamily: vi.fn(),
    revokeSessionById: vi.fn(),
    revokeAllSessionsForUser: vi.fn(),
    incrementTokenVersion: vi.fn(),
    consumeRateLimitCounter: vi.fn(),
    upsertAuditDedupCounter: vi.fn(),
    upsertBehaviorBucket: vi.fn(),
    getBehaviorMetrics: vi.fn(),
    getRiskStateForUpdate: vi.fn(),
    saveRiskState: vi.fn(),
    readTokenEpoch: vi.fn(),
    getEpochBumpImpact: vi.fn(),
    createEpochBumpRequest: vi.fn(),
    findEpochBumpRequestForUpdate: vi.fn(),
    markEpochBumpRequestConfirmed: vi.fn(),
    markEpochBumpRequestExpired: vi.fn(),
    bumpTokenEpoch: vi.fn(),
    appendAuditEvent: vi.fn(),
    findSessionAuthContext: vi.fn(),
    findUserProfile: vi.fn(),
  } as unknown as AuthRepository;
}

describe("AuthService", () => {
  it("runs password compare even when user is missing", async () => {
    const repository = createMockRepository();
    vi.mocked(repository.findLoginCandidateForUpdate).mockResolvedValue(null);
    vi.mocked(repository.lockActiveSessionsForUser).mockResolvedValue([]);

    const comparePassword = vi.fn().mockResolvedValue(false);
    const service = new AuthService({
      repository,
      jwtSecret: "test-secret",
      comparePassword,
      hashPassword: vi.fn(),
      uuid: vi.fn().mockReturnValue("00000000-0000-0000-0000-000000000001"),
    });

    await expect(
      service.login(
        {} as PoolClient,
        {
          orgId: "11111111-1111-1111-1111-111111111111",
          email: "missing@example.com",
          password: "wrong",
        },
        { ipAddress: null, userAgent: null },
      ),
    ).rejects.toThrow("Invalid email or password");
    expect(comparePassword).toHaveBeenCalledTimes(1);
  });

  it("returns uniform login error for policy-denied user", async () => {
    const repository = createMockRepository();
    vi.mocked(repository.findLoginCandidateForUpdate).mockResolvedValue({
      user_id: "u1",
      org_id: "o1",
      email: "user@example.com",
      password_hash: "hash",
      role: "admin",
      token_version: 0,
      email_verified: false,
      failed_attempts: 0,
      locked_until: null,
      deactivated_at: null,
      org_status: "APPROVED",
    });

    const service = new AuthService({
      repository,
      jwtSecret: "test-secret",
      comparePassword: vi.fn().mockResolvedValue(true),
      hashPassword: vi.fn(),
      uuid: vi.fn().mockReturnValue("00000000-0000-0000-0000-000000000001"),
    });

    await expect(
      service.login(
        {} as PoolClient,
        {
          orgId: "o1",
          email: "user@example.com",
          password: "Password!234",
        },
        { ipAddress: null, userAgent: null },
      ),
    ).rejects.toThrow("Invalid email or password");
  });

  it("on refresh reuse revokes family and increments token version", async () => {
    const repository = createMockRepository();
    const tokenPair = issueTokenPair(
      {
        userId: "u1",
        orgId: "o1",
        sessionId: "s1",
        sessionFamilyId: "f1",
        tokenVersion: 0,
      },
      {
        jwtSecret: "test-secret",
        issuer: "core-backend-auth",
        accessTtlSeconds: 900,
        refreshTtlSeconds: 3600,
      },
    );

    vi.mocked(repository.findSessionForRefreshUpdate).mockResolvedValue({
      id: "s1",
      user_id: "u1",
      org_id: "o1",
      session_family_id: "f1",
      refresh_token_hash: "a".repeat(64),
      device_context_hash: "b".repeat(64),
      user_agent: "ua",
      ip_address: "127.0.0.1",
      issued_at: new Date(Date.now() - 5 * 60 * 1000),
      revoked_at: new Date(),
      replaced_by_session_id: "s2",
      absolute_expires_at: new Date(Date.now() + 10000),
      idle_expires_at: new Date(Date.now() + 10000),
      last_used_at: new Date(),
      user_token_version: 0,
      email_verified: true,
      user_deactivated_at: null,
      org_status: "APPROVED",
      token_epoch: new Date(0),
      sensitive_reauth_required: false,
    });
    vi.mocked(repository.upsertBehaviorBucket).mockResolvedValue();
    vi.mocked(repository.getBehaviorMetrics).mockResolvedValue({
      refresh_1m: 1,
      refresh_5m: 1,
      mismatch_30m: 0,
      ip_churn_30m: 0,
    });
    vi.mocked(repository.getRiskStateForUpdate).mockResolvedValue({
      session_id: "s1",
      risk_score: 0,
      transient_risk_score: 0,
      persistent_risk_score: 0,
      confidence_score: 0,
      effective_risk_score: 0,
      risk_level: "LOW",
      sensitive_reauth_required: false,
      baseline_refresh_interval_seconds: null,
      baseline_confidence: 0,
      last_refresh_at: new Date(),
      last_decay_at: new Date(),
      last_anomaly_at: null,
      anomaly_reasons: {},
    });
    vi.mocked(repository.saveRiskState).mockResolvedValue();
    vi.mocked(repository.revokeSessionFamily).mockResolvedValue(1);
    vi.mocked(repository.incrementTokenVersion).mockResolvedValue(1);

    const service = new AuthService({
      repository,
      jwtSecret: "test-secret",
      hashPassword: vi.fn(),
      comparePassword: vi.fn(),
    });

    await expect(
      service.refresh(
        {} as PoolClient,
        { refreshToken: tokenPair.refreshToken },
        { ipAddress: "127.0.0.1", userAgent: "test" },
      ),
    ).rejects.toThrow("Re-authentication required");

    expect(repository.revokeSessionFamily).toHaveBeenCalledTimes(1);
    expect(repository.incrementTokenVersion).toHaveBeenCalledTimes(1);
  });

  it("freezes baseline updates when current session risk is already high", async () => {
    const repository = createMockRepository();
    const tokenPair = issueTokenPair(
      {
        userId: "u1",
        orgId: "o1",
        sessionId: "s1",
        sessionFamilyId: "f1",
        tokenVersion: 0,
      },
      {
        jwtSecret: "test-secret",
        issuer: "core-backend-auth",
        accessTtlSeconds: 900,
        refreshTtlSeconds: 3600,
      },
    );

    vi.mocked(repository.findSessionForRefreshUpdate).mockResolvedValue({
      id: "s1",
      user_id: "u1",
      org_id: "o1",
      session_family_id: "f1",
      refresh_token_hash: hashRefreshToken(tokenPair.refreshToken),
      device_context_hash: null,
      user_agent: "ua",
      ip_address: "127.0.0.1",
      issued_at: new Date(Date.now() - 60 * 60 * 1000),
      revoked_at: null,
      replaced_by_session_id: null,
      absolute_expires_at: new Date(Date.now() + 100000),
      idle_expires_at: new Date(Date.now() + 100000),
      last_used_at: new Date(),
      user_token_version: 0,
      email_verified: true,
      user_deactivated_at: null,
      org_status: "APPROVED",
      token_epoch: new Date(0),
      sensitive_reauth_required: false,
    });
    vi.mocked(repository.upsertBehaviorBucket).mockResolvedValue();
    vi.mocked(repository.getBehaviorMetrics).mockResolvedValue({
      refresh_1m: 1,
      refresh_5m: 1,
      mismatch_30m: 0,
      ip_churn_30m: 0,
    });
    vi.mocked(repository.getRiskStateForUpdate).mockResolvedValue({
      session_id: "s1",
      risk_score: 12,
      transient_risk_score: 7,
      persistent_risk_score: 5,
      confidence_score: 0.9,
      effective_risk_score: 10.8,
      risk_level: "MEDIUM",
      sensitive_reauth_required: false,
      baseline_refresh_interval_seconds: 300,
      baseline_confidence: 1,
      last_refresh_at: new Date(Date.now() - 30 * 1000),
      last_decay_at: new Date(),
      last_anomaly_at: null,
      anomaly_reasons: {},
    });
    vi.mocked(repository.saveRiskState).mockResolvedValue();
    vi.mocked(repository.lockActiveSessionsForUser).mockResolvedValue([]);
    vi.mocked(repository.insertSession).mockResolvedValue({ id: "s2" });
    vi.mocked(repository.markSessionRotated).mockResolvedValue();
    vi.mocked(repository.touchSessionUsage).mockResolvedValue();
    vi.mocked(repository.revokeSessionsByIds).mockResolvedValue(0);
    vi.mocked(repository.appendAuditEvent).mockResolvedValue();

    const service = new AuthService({
      repository,
      jwtSecret: "test-secret",
      hashPassword: vi.fn(),
      comparePassword: vi.fn(),
    });

    await expect(
      service.refresh(
        {} as PoolClient,
        { refreshToken: tokenPair.refreshToken },
        { ipAddress: "127.0.0.1", userAgent: "test" },
      ),
    ).rejects.toThrow("Sensitive action requires re-authentication");

    const saveArgs = vi.mocked(repository.saveRiskState).mock.calls[0][1];
    expect(saveArgs.baselineRefreshIntervalSeconds).toBe(300);
  });

  it("decays transient risk faster than persistent risk", async () => {
    const repository = createMockRepository();
    const tokenPair = issueTokenPair(
      {
        userId: "u1",
        orgId: "o1",
        sessionId: "s1",
        sessionFamilyId: "f1",
        tokenVersion: 0,
      },
      {
        jwtSecret: "test-secret",
        issuer: "core-backend-auth",
        accessTtlSeconds: 900,
        refreshTtlSeconds: 3600,
      },
    );

    vi.mocked(repository.findSessionForRefreshUpdate).mockResolvedValue({
      id: "s1",
      user_id: "u1",
      org_id: "o1",
      session_family_id: "f1",
      refresh_token_hash: hashRefreshToken(tokenPair.refreshToken),
      device_context_hash: null,
      user_agent: "ua",
      ip_address: "127.0.0.1",
      issued_at: new Date(Date.now() - 48 * 60 * 60 * 1000),
      revoked_at: null,
      replaced_by_session_id: null,
      absolute_expires_at: new Date(Date.now() + 100000),
      idle_expires_at: new Date(Date.now() + 100000),
      last_used_at: new Date(),
      user_token_version: 0,
      email_verified: true,
      user_deactivated_at: null,
      org_status: "APPROVED",
      token_epoch: new Date(0),
      sensitive_reauth_required: false,
    });
    vi.mocked(repository.upsertBehaviorBucket).mockResolvedValue();
    vi.mocked(repository.getBehaviorMetrics).mockResolvedValue({
      refresh_1m: 1,
      refresh_5m: 1,
      mismatch_30m: 0,
      ip_churn_30m: 0,
    });
    vi.mocked(repository.getRiskStateForUpdate).mockResolvedValue({
      session_id: "s1",
      risk_score: 9,
      transient_risk_score: 5,
      persistent_risk_score: 4,
      confidence_score: 0.8,
      effective_risk_score: 7.2,
      risk_level: "MEDIUM",
      sensitive_reauth_required: false,
      baseline_refresh_interval_seconds: 600,
      baseline_confidence: 1,
      last_refresh_at: new Date(Date.now() - 20 * 60 * 1000),
      last_decay_at: new Date(Date.now() - 13 * 60 * 60 * 1000),
      last_anomaly_at: null,
      anomaly_reasons: {},
    });
    vi.mocked(repository.saveRiskState).mockResolvedValue();
    vi.mocked(repository.lockActiveSessionsForUser).mockResolvedValue([]);
    vi.mocked(repository.insertSession).mockResolvedValue({ id: "s2" });
    vi.mocked(repository.markSessionRotated).mockResolvedValue();
    vi.mocked(repository.touchSessionUsage).mockResolvedValue();
    vi.mocked(repository.revokeSessionsByIds).mockResolvedValue(0);
    vi.mocked(repository.appendAuditEvent).mockResolvedValue();

    const service = new AuthService({
      repository,
      jwtSecret: "test-secret",
      hashPassword: vi.fn(),
      comparePassword: vi.fn(),
    });

    await service.refresh(
      {} as PoolClient,
      { refreshToken: tokenPair.refreshToken },
      { ipAddress: "127.0.0.1", userAgent: "test" },
    );

    const saveArgs = vi.mocked(repository.saveRiskState).mock.calls[0][1];
    expect(saveArgs.transientRiskScore).toBeLessThanOrEqual(0);
    expect(saveArgs.persistentRiskScore).toBeGreaterThanOrEqual(3);
  });

  it("computes LOW/MEDIUM/HIGH risk levels for epoch bump dry-run impact", async () => {
    const repository = createMockRepository();
    vi.mocked(repository.findUserProfile).mockResolvedValue({
      user_id: "u1",
      org_id: "o1",
      email: "admin@example.com",
      role: "admin",
      token_version: 0,
      email_verified: true,
      org_status: "APPROVED",
    });
    vi.mocked(repository.appendAuditEvent).mockResolvedValue();

    const service = new AuthService({
      repository,
      jwtSecret: "test-secret",
      hashPassword: vi.fn(),
      comparePassword: vi.fn(),
    });

    const claims = {
      userId: "u1",
      orgId: "o1",
      sessionId: "s1",
      sessionFamilyId: "f1",
      tokenVersion: 0,
      tokenKind: "access" as const,
      iat: 1,
      exp: 2,
    };

    vi.mocked(repository.getEpochBumpImpact)
      .mockResolvedValueOnce({
        affected_sessions: 10,
        affected_users: 10,
        affected_orgs: 1,
      })
      .mockResolvedValueOnce({
        affected_sessions: 1000,
        affected_users: 10,
        affected_orgs: 1,
      })
      .mockResolvedValueOnce({
        affected_sessions: 10,
        affected_users: 20000,
        affected_orgs: 1,
      });

    const low = await service.previewTokenEpochBumpImpact(
      {} as PoolClient,
      claims,
      "low blast radius",
      { ipAddress: "127.0.0.1", userAgent: "ua" },
    );
    const medium = await service.previewTokenEpochBumpImpact(
      {} as PoolClient,
      claims,
      "medium blast radius",
      { ipAddress: "127.0.0.1", userAgent: "ua" },
    );
    const high = await service.previewTokenEpochBumpImpact(
      {} as PoolClient,
      claims,
      "high blast radius",
      { ipAddress: "127.0.0.1", userAgent: "ua" },
    );

    expect(low.risk_level).toBe("LOW");
    expect(medium.risk_level).toBe("MEDIUM");
    expect(high.risk_level).toBe("HIGH");

    expect(repository.appendAuditEvent).toHaveBeenCalledTimes(3);
    const firstAudit = vi.mocked(repository.appendAuditEvent).mock.calls[0][1];
    expect(firstAudit.eventType).toBe("TOKEN_EPOCH_BUMP_DRY_RUN");
    expect(firstAudit.severity).toBe("WARNING");
  });
});
