import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { AUTH_ERRORS } from "./errors.js";
import { SoftMemoryRateLimiter } from "./rate-limiter.js";
import {
  AuthRepository,
  type EpochBumpImpact,
  type EpochBumpResult,
  type RefreshSession,
} from "./repository.js";
import {
  hashDeviceContext,
  hashRefreshToken,
  issueTokenPair,
  timingSafeTokenHashEqual,
  verifyToken,
} from "./tokens.js";
import type {
  AuthAction,
  AuthClaims,
  AuthRequestMeta,
  RateLimitDecision,
  TokenPair,
} from "./types.js";

type RegisterInput = {
  organizationName: string;
  email: string;
  password: string;
  role?: string;
};

type LoginInput = {
  orgId: string;
  email: string;
  password: string;
};

type RefreshInput = {
  refreshToken: string;
};

type LogoutInput = {
  claims: AuthClaims;
};

type MeInput = {
  claims: AuthClaims;
};

type RegisterResult = {
  orgId: string;
  userId: string;
};

type MeResult = {
  userId: string;
  orgId: string;
  email: string;
  role: string;
  tokenVersion: number;
};

type BumpTokenEpochResult = {
  requestId: string;
  confirmationToken: string;
  expiresAt: string;
};

type ConfirmTokenEpochBumpResult = {
  previousEpoch: string;
  newEpoch: string;
  bumpedAt: string;
};

type EpochBumpDryRunRiskLevel = "LOW" | "MEDIUM" | "HIGH";

type EpochBumpDryRunResult = {
  affected_sessions: number;
  affected_users: number;
  affected_orgs: number;
  risk_level: EpochBumpDryRunRiskLevel;
};

type ServiceOptions = {
  repository: AuthRepository;
  jwtSecret: string;
  issuer?: string;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  refreshIdleTtlSeconds?: number;
  maxActiveSessions?: number;
  now?: () => Date;
  comparePassword?: (plaintext: string, hash: string) => Promise<boolean>;
  hashPassword?: (plaintext: string, rounds: number) => Promise<string>;
  uuid?: () => string;
  createEpochConfirmationToken?: () => string;
  rateLimiter?: SoftMemoryRateLimiter;
};

type RiskSignal = {
  signal: string;
  weight: number;
  confidence: number;
  persistent?: boolean;
  critical?: boolean;
};

const DEFAULT_ISSUER = "core-backend-auth";
const DEFAULT_ACCESS_TTL_SECONDS = 15 * 60;
const DEFAULT_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_REFRESH_IDLE_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_MAX_ACTIVE_SESSIONS = 5;
const DEFAULT_BCRYPT_ROUNDS = 12;
const DEFAULT_BURST_REFRESH_PER_MINUTE = 12;
const DEFAULT_BURST_REFRESH_PER_FIVE_MIN = 30;
const DEFAULT_BASELINE_DEVIATION_RATIO_THRESHOLD = 0.35;
const DEFAULT_BASELINE_FREEZE_EFFECTIVE_RISK_THRESHOLD = 8;
const DEFAULT_MIN_REFRESH_INTERVAL_SECONDS = 60;
const DEFAULT_MAX_REFRESH_INTERVAL_SECONDS = 2 * 60 * 60;
const DEFAULT_EWMA_ALPHA = 0.1;
const DEFAULT_TRANSIENT_DECAY_MINUTES = 15;
const DEFAULT_PERSISTENT_DECAY_MINUTES = 12 * 60;
const DEFAULT_AUDIT_DEDUP_SHARD_COUNT = 16;
const DEFAULT_EPOCH_BUMP_CONFIRMATION_TTL_SECONDS = 120;
const DEFAULT_EPOCH_BUMP_CONFIRMATION_MIN_DELAY_SECONDS = 3;
const DUMMY_PASSWORD_HASH =
  "$2b$12$Nr88mnQNh0mzN6S6lS8dhuTLzlQSUdkGFUTkOcJCIZy9lEi5Vf3Lq";

export class AuthService {
  private readonly repository: AuthRepository;
  private readonly jwtSecret: string;
  private readonly issuer: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;
  private readonly refreshIdleTtlSeconds: number;
  private readonly maxActiveSessions: number;
  private readonly now: () => Date;
  private readonly comparePassword: (plaintext: string, hash: string) => Promise<boolean>;
  private readonly hashPassword: (plaintext: string, rounds: number) => Promise<string>;
  private readonly uuid: () => string;
  private readonly createEpochConfirmationToken: () => string;
  private readonly rateLimiter: SoftMemoryRateLimiter;

  public constructor(options: ServiceOptions) {
    this.repository = options.repository;
    this.jwtSecret = options.jwtSecret;
    this.issuer = options.issuer ?? DEFAULT_ISSUER;
    this.accessTtlSeconds = options.accessTtlSeconds ?? DEFAULT_ACCESS_TTL_SECONDS;
    this.refreshTtlSeconds = options.refreshTtlSeconds ?? DEFAULT_REFRESH_TTL_SECONDS;
    this.refreshIdleTtlSeconds =
      options.refreshIdleTtlSeconds ?? DEFAULT_REFRESH_IDLE_TTL_SECONDS;
    this.maxActiveSessions = options.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS;
    this.now = options.now ?? (() => new Date());
    this.comparePassword = options.comparePassword ?? bcrypt.compare;
    this.hashPassword = options.hashPassword ?? bcrypt.hash;
    this.uuid = options.uuid ?? randomUUID;
    this.createEpochConfirmationToken =
      options.createEpochConfirmationToken ?? (() => randomBytes(32).toString("hex"));
    this.rateLimiter = options.rateLimiter ?? new SoftMemoryRateLimiter();
  }

  public precheckRateLimit(
    flow: "login_ip" | "login_user" | "refresh_ip" | "refresh_session",
    key: string,
  ): void {
    const counterKey = `${flow}:${key}`;
    if (this.rateLimiter.isBlocked(counterKey, this.now())) {
      throw AUTH_ERRORS.RATE_LIMITED();
    }
  }

  public async consumeRateLimit(
    tx: PoolClient,
    flow: "login_ip" | "login_user" | "refresh_ip" | "refresh_session",
    key: string,
  ): Promise<void> {
    const now = this.now();
    const counterKey = `${flow}:${key}`;

    const windowSeconds =
      flow === "refresh_session"
        ? 5 * 60
        : flow === "refresh_ip"
          ? 15 * 60
          : 15 * 60;

    const limit =
      flow === "login_ip"
        ? 20
        : flow === "login_user"
          ? 5
          : flow === "refresh_ip"
            ? 60
            : 10;

    const decision = await this.repository.consumeRateLimitCounter(tx, {
      counterKey,
      windowSeconds,
      limit,
      now,
    });
    this.syncMemoryLimiter(counterKey, decision);
    if (decision.blocked) {
      throw AUTH_ERRORS.RATE_LIMITED();
    }
  }

  public parseRefreshClaims(refreshToken: string): AuthClaims {
    return this.parseClaims(refreshToken, "refresh");
  }

  public toLoginLimiterKeys(input: LoginInput, requestMeta: AuthRequestMeta): string[] {
    return [
      `${requestMeta.ipAddress ?? "unknown"}`,
      `${input.orgId}:${input.email.trim().toLowerCase()}`,
    ];
  }

  public toRefreshLimiterKeys(
    claims: AuthClaims,
    requestMeta: AuthRequestMeta,
  ): { ip: string; session: string } {
    return {
      ip: `${requestMeta.ipAddress ?? "unknown"}`,
      session: claims.sessionId,
    };
  }

  public async register(
    tx: PoolClient,
    input: RegisterInput,
    requestMeta: AuthRequestMeta,
  ): Promise<RegisterResult> {
    const passwordHash = await this.hashPassword(input.password, DEFAULT_BCRYPT_ROUNDS);
    const organization = await this.repository.createOrganization(tx, {
      name: input.organizationName,
      status: "PENDING",
    });
    const user = await this.repository.createUser(tx, {
      orgId: organization.id,
      email: input.email,
      passwordHash,
      role: input.role ?? "admin",
      emailVerified: false,
    });

    await this.repository.insertPasswordHistory(tx, user.id, passwordHash);
    await this.repository.appendAuditEvent(tx, {
      eventType: "REGISTER",
      severity: "INFO",
      userId: user.id,
      orgId: organization.id,
      sessionId: null,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: { mode: "self_service" },
    });

    return { orgId: organization.id, userId: user.id };
  }

  public async login(
    tx: PoolClient,
    input: LoginInput,
    requestMeta: AuthRequestMeta,
  ): Promise<TokenPair> {
    const candidate = await this.repository.findLoginCandidateForUpdate(
      tx,
      input.orgId,
      input.email,
    );

    const hashToCompare = candidate?.password_hash ?? DUMMY_PASSWORD_HASH;
    const passwordMatches = await this.comparePassword(input.password, hashToCompare);

    if (!candidate || !passwordMatches || !this.isCandidateAllowed(candidate)) {
      if (candidate) {
        await this.appendAuditWithDedup(tx, {
          eventType: "LOGIN_FAILED",
          severity: "WARNING",
          userId: candidate.user_id,
          orgId: candidate.org_id,
          sessionId: null,
          ipAddress: requestMeta.ipAddress,
          userAgent: requestMeta.userAgent,
          metadata: { reason: "uniform_denial" },
        });
      }
      throw AUTH_ERRORS.INVALID_LOGIN();
    }

    await this.lockAndTrimSessionsBeforeInsert(tx, candidate.user_id, true);

    const sessionId = this.uuid();
    const familyId = this.uuid();
    const issuedAt = this.now();
    const absoluteExpiresAt = new Date(issuedAt.getTime() + this.refreshTtlSeconds * 1000);
    const idleExpiresAt = new Date(issuedAt.getTime() + this.refreshIdleTtlSeconds * 1000);

    const tokenPair = issueTokenPair(
      {
        userId: candidate.user_id,
        orgId: candidate.org_id,
        sessionId,
        sessionFamilyId: familyId,
        tokenVersion: candidate.token_version,
      },
      {
        jwtSecret: this.jwtSecret,
        issuer: this.issuer,
        accessTtlSeconds: this.accessTtlSeconds,
        refreshTtlSeconds: this.refreshTtlSeconds,
      },
    );

    await this.repository.insertSession(tx, {
      id: sessionId,
      userId: candidate.user_id,
      orgId: candidate.org_id,
      sessionFamilyId: familyId,
      refreshTokenHash: hashRefreshToken(tokenPair.refreshToken),
      deviceContextHash: hashDeviceContext(requestMeta.userAgent, requestMeta.ipAddress),
      userAgent: requestMeta.userAgent,
      ipAddress: requestMeta.ipAddress,
      issuedAt,
      lastUsedAt: issuedAt,
      absoluteExpiresAt,
      idleExpiresAt,
    });

    await this.repository.appendAuditEvent(tx, {
      eventType: "LOGIN_SUCCESS",
      severity: "INFO",
      userId: candidate.user_id,
      orgId: candidate.org_id,
      sessionId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: {},
    });

    return tokenPair;
  }

  public async refresh(
    tx: PoolClient,
    input: RefreshInput,
    requestMeta: AuthRequestMeta,
  ): Promise<TokenPair> {
    const now = this.now();
    const claims = this.parseClaims(input.refreshToken, "refresh");
    const refreshTokenHash = hashRefreshToken(input.refreshToken);
    const sourceSession = await this.repository.findSessionForRefreshUpdate(tx, refreshTokenHash);

    if (!sourceSession) {
      throw AUTH_ERRORS.FORCE_REAUTH();
    }

    const deviceContextHash = hashDeviceContext(requestMeta.userAgent, requestMeta.ipAddress);
    const isDeviceMismatch =
      sourceSession.device_context_hash !== null &&
      !timingSafeTokenHashEqual(sourceSession.device_context_hash, deviceContextHash);
    const isIpChurn = this.ipPrefix(sourceSession.ip_address) !== this.ipPrefix(requestMeta.ipAddress);

    const hashMismatch = !timingSafeTokenHashEqual(
      sourceSession.refresh_token_hash,
      refreshTokenHash,
    );
    const tupleMismatch = !this.isSessionTupleConsistent(sourceSession, claims);
    const reused = Boolean(sourceSession.revoked_at || sourceSession.replaced_by_session_id);

    if (hashMismatch || tupleMismatch || reused) {
      await this.updateBehaviorAndRisk(
        tx,
        sourceSession,
        now,
        isDeviceMismatch,
        isIpChurn,
        [
          {
            signal: "reuse_detection",
            weight: 10,
            confidence: 1,
            persistent: true,
            critical: true,
          },
        ],
      );
      await this.handleRefreshReuse(
        tx,
        sourceSession,
        hashMismatch ? "hash_mismatch" : tupleMismatch ? "tuple_mismatch" : "reused_refresh_token",
        requestMeta,
      );
    }

    if (sourceSession.absolute_expires_at <= now || sourceSession.idle_expires_at <= now) {
      await this.repository.revokeSessionById(tx, sourceSession.id, "SESSION_EXPIRED");
      throw AUTH_ERRORS.FORCE_REAUTH();
    }

    if (
      sourceSession.user_token_version !== claims.tokenVersion ||
      sourceSession.org_status !== "APPROVED" ||
      !sourceSession.email_verified ||
      sourceSession.user_deactivated_at
    ) {
      throw AUTH_ERRORS.FORCE_REAUTH();
    }

    if (claims.iat * 1000 < sourceSession.token_epoch.getTime()) {
      throw AUTH_ERRORS.FORCE_REAUTH();
    }

    const riskState = await this.updateBehaviorAndRisk(
      tx,
      sourceSession,
      now,
      isDeviceMismatch,
      isIpChurn,
      [],
    );

    if (riskState.sensitiveReauthRequired) {
      throw AUTH_ERRORS.SENSITIVE_REAUTH_REQUIRED();
    }

    await this.lockAndTrimSessionsBeforeInsert(tx, sourceSession.user_id, false);

    const replacementSessionId = this.uuid();
    const issuedAt = now;
    const absoluteExpiresAt = new Date(issuedAt.getTime() + this.refreshTtlSeconds * 1000);
    const idleExpiresAt = new Date(issuedAt.getTime() + this.refreshIdleTtlSeconds * 1000);

    const tokenPair = issueTokenPair(
      {
        userId: sourceSession.user_id,
        orgId: sourceSession.org_id,
        sessionId: replacementSessionId,
        sessionFamilyId: sourceSession.session_family_id,
        tokenVersion: sourceSession.user_token_version,
      },
      {
        jwtSecret: this.jwtSecret,
        issuer: this.issuer,
        accessTtlSeconds: this.accessTtlSeconds,
        refreshTtlSeconds: this.refreshTtlSeconds,
      },
    );

    await this.repository.insertSession(tx, {
      id: replacementSessionId,
      userId: sourceSession.user_id,
      orgId: sourceSession.org_id,
      sessionFamilyId: sourceSession.session_family_id,
      refreshTokenHash: hashRefreshToken(tokenPair.refreshToken),
      deviceContextHash,
      userAgent: requestMeta.userAgent,
      ipAddress: requestMeta.ipAddress,
      issuedAt,
      lastUsedAt: issuedAt,
      absoluteExpiresAt,
      idleExpiresAt,
    });

    await this.repository.markSessionRotated(tx, sourceSession.id, replacementSessionId);
    await this.repository.touchSessionUsage(
      tx,
      replacementSessionId,
      requestMeta.userAgent,
      requestMeta.ipAddress,
    );
    await this.enforceSessionCap(tx, sourceSession.user_id, this.maxActiveSessions);

    await this.repository.appendAuditEvent(tx, {
      eventType: "REFRESH",
      severity: "INFO",
      userId: sourceSession.user_id,
      orgId: sourceSession.org_id,
      sessionId: replacementSessionId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: {},
    });

    return tokenPair;
  }

  public async logout(tx: PoolClient, input: LogoutInput): Promise<void> {
    const session = await this.repository.findSessionAuthContext(tx, input.claims.sessionId);
    if (!session) {
      return;
    }
    if (
      session.user_id !== input.claims.userId ||
      session.session_id !== input.claims.sessionId ||
      session.session_family_id !== input.claims.sessionFamilyId
    ) {
      throw AUTH_ERRORS.FORCE_REAUTH();
    }

    await this.repository.revokeSessionById(tx, input.claims.sessionId, "USER_LOGOUT");
    await this.repository.appendAuditEvent(tx, {
      eventType: "LOGOUT",
      severity: "INFO",
      userId: input.claims.userId,
      orgId: input.claims.orgId,
      sessionId: input.claims.sessionId,
      ipAddress: null,
      userAgent: null,
      metadata: {},
    });
  }

  public async logoutAll(tx: PoolClient, input: LogoutInput): Promise<void> {
    const context = await this.repository.findSessionAuthContext(tx, input.claims.sessionId);
    if (!context) {
      throw AUTH_ERRORS.UNAUTHORIZED();
    }
    this.assertActionAllowed("REVOKE_ALL_SESSIONS", context.sensitive_reauth_required);

    await this.repository.revokeAllSessionsForUser(tx, input.claims.userId, "USER_LOGOUT_ALL");
    await this.repository.incrementTokenVersion(tx, input.claims.userId);
    await this.repository.appendAuditEvent(tx, {
      eventType: "LOGOUT_ALL",
      severity: "WARNING",
      userId: input.claims.userId,
      orgId: input.claims.orgId,
      sessionId: null,
      ipAddress: null,
      userAgent: null,
      metadata: {},
    });
  }

  public async requestTokenEpochBump(
    tx: PoolClient,
    claims: AuthClaims,
    reason: string,
    requestMeta: AuthRequestMeta,
  ): Promise<BumpTokenEpochResult> {
    const normalizedReason = reason.trim();
    if (normalizedReason.length === 0) {
      throw AUTH_ERRORS.EPOCH_BUMP_REASON_REQUIRED();
    }

    const profile = await this.repository.findUserProfile(tx, claims.userId);
    if (!profile || profile.role !== "admin") {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const requestRateLimit = await this.repository.consumeRateLimitCounter(tx, {
      counterKey: `epoch_bump_request:${claims.userId}`,
      windowSeconds: 3600,
      limit: 10,
      now: this.now(),
    });
    if (requestRateLimit.blocked) {
      throw AUTH_ERRORS.EPOCH_BUMP_RATE_LIMITED();
    }

    const requestedAt = this.now();
    const expiresAt = new Date(
      requestedAt.getTime() + DEFAULT_EPOCH_BUMP_CONFIRMATION_TTL_SECONDS * 1000,
    );
    const confirmationToken = this.createEpochConfirmationToken();
    const confirmationTokenHash = hashRefreshToken(confirmationToken);
    const requesterContextHash = hashDeviceContext(
      requestMeta.userAgent,
      requestMeta.ipAddress,
    );

    const requestRecord = await this.repository.createEpochBumpRequest(tx, {
      requesterUserId: claims.userId,
      requesterSessionId: claims.sessionId,
      requesterContextHash,
      reason: normalizedReason,
      confirmationTokenHash,
      requestedAt,
      expiresAt,
    });

    await this.repository.appendAuditEvent(tx, {
      eventType: "CRITICAL_SECURITY_EVENT",
      severity: "WARNING",
      userId: claims.userId,
      orgId: claims.orgId,
      sessionId: claims.sessionId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: {
        category: "token_epoch_bump_requested",
        request_id: requestRecord.id,
        reason: normalizedReason,
        expires_at: requestRecord.expires_at.toISOString(),
      },
    });

    return {
      requestId: requestRecord.id,
      confirmationToken,
      expiresAt: requestRecord.expires_at.toISOString(),
    };
  }

  public async previewTokenEpochBumpImpact(
    tx: PoolClient,
    claims: AuthClaims,
    reason: string,
    requestMeta: AuthRequestMeta,
  ): Promise<EpochBumpDryRunResult> {
    const normalizedReason = reason.trim();
    if (normalizedReason.length === 0) {
      throw AUTH_ERRORS.EPOCH_BUMP_REASON_REQUIRED();
    }

    const profile = await this.repository.findUserProfile(tx, claims.userId);
    if (!profile || profile.role !== "admin") {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const now = this.now();
    const impact = await this.repository.getEpochBumpImpact(tx, now);
    const riskLevel = this.getEpochBumpDryRunRiskLevel(impact);

    await this.repository.appendAuditEvent(tx, {
      eventType: "TOKEN_EPOCH_BUMP_DRY_RUN",
      severity: "WARNING",
      userId: claims.userId,
      orgId: claims.orgId,
      sessionId: claims.sessionId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: {
        category: "token_epoch_bump_dry_run",
        admin_user_id: claims.userId,
        admin_org_id: claims.orgId,
        reason: normalizedReason,
        affected_sessions: impact.affected_sessions,
        affected_users: impact.affected_users,
        affected_orgs: impact.affected_orgs,
        risk_level: riskLevel,
        evaluated_at: now.toISOString(),
        request_ip: requestMeta.ipAddress,
        user_agent: requestMeta.userAgent,
      },
    });

    return {
      affected_sessions: impact.affected_sessions,
      affected_users: impact.affected_users,
      affected_orgs: impact.affected_orgs,
      risk_level: riskLevel,
    };
  }

  public async confirmTokenEpochBump(
    tx: PoolClient,
    claims: AuthClaims,
    confirmationToken: string,
    requestMeta: AuthRequestMeta,
  ): Promise<ConfirmTokenEpochBumpResult> {
    const normalizedToken = confirmationToken.trim();
    if (normalizedToken.length === 0) {
      throw AUTH_ERRORS.EPOCH_BUMP_CONFIRMATION_REQUIRED();
    }

    const profile = await this.repository.findUserProfile(tx, claims.userId);
    if (!profile || profile.role !== "admin") {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const request = await this.repository.findEpochBumpRequestForUpdate(
      tx,
      hashRefreshToken(normalizedToken),
    );
    if (!request) {
      throw AUTH_ERRORS.EPOCH_BUMP_CONFIRMATION_INVALID();
    }

    if (request.status === "CONFIRMED") {
      throw AUTH_ERRORS.EPOCH_BUMP_CONFIRMATION_REUSED();
    }
    if (request.status === "EXPIRED") {
      throw AUTH_ERRORS.EPOCH_BUMP_CONFIRMATION_EXPIRED();
    }
    if (request.status !== "PENDING") {
      throw AUTH_ERRORS.EPOCH_BUMP_CONFIRMATION_INVALID();
    }
    if (request.requester_user_id !== claims.userId) {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }
    if (!request.requester_session_id || request.requester_session_id !== claims.sessionId) {
      throw AUTH_ERRORS.EPOCH_BUMP_CONFIRMATION_INVALID();
    }
    const currentContextHash = hashDeviceContext(
      requestMeta.userAgent,
      requestMeta.ipAddress,
    );
    if (
      !request.requester_context_hash ||
      !timingSafeTokenHashEqual(request.requester_context_hash, currentContextHash)
    ) {
      throw AUTH_ERRORS.EPOCH_BUMP_CONFIRMATION_INVALID();
    }

    const now = this.now();
    if (request.expires_at <= now) {
      await this.repository.markEpochBumpRequestExpired(tx, request.id);
      throw AUTH_ERRORS.EPOCH_BUMP_CONFIRMATION_EXPIRED();
    }
    const earliestConfirmAt = new Date(
      request.requested_at.getTime() + DEFAULT_EPOCH_BUMP_CONFIRMATION_MIN_DELAY_SECONDS * 1000,
    );
    if (now < earliestConfirmAt) {
      throw AUTH_ERRORS.EPOCH_BUMP_CONFIRMATION_TOO_SOON();
    }

    const confirmRateLimit = await this.repository.consumeRateLimitCounter(tx, {
      counterKey: "epoch_bump:global",
      windowSeconds: 3600,
      limit: 3,
      now,
    });
    if (confirmRateLimit.blocked) {
      throw AUTH_ERRORS.EPOCH_BUMP_RATE_LIMITED();
    }

    await this.repository.markEpochBumpRequestConfirmed(tx, request.id, claims.userId, now);

    const result: EpochBumpResult = await this.repository.bumpTokenEpoch(
      tx,
      claims.userId,
      request.reason,
      now,
    );

    await this.repository.appendAuditEvent(tx, {
      eventType: "CRITICAL_SECURITY_EVENT",
      severity: "CRITICAL",
      userId: claims.userId,
      orgId: claims.orgId,
      sessionId: claims.sessionId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: {
        category: "token_epoch_bump_confirmed",
        request_id: request.id,
        reason: request.reason,
        previous_epoch: result.previousEpoch.toISOString(),
        new_epoch: result.newEpoch.toISOString(),
      },
    });

    return {
      previousEpoch: result.previousEpoch.toISOString(),
      newEpoch: result.newEpoch.toISOString(),
      bumpedAt: result.bumpedAt.toISOString(),
    };
  }

  public async me(tx: PoolClient, input: MeInput): Promise<MeResult> {
    const profile = await this.repository.findUserProfile(tx, input.claims.userId);
    if (!profile) {
      throw AUTH_ERRORS.UNAUTHORIZED();
    }
    if (profile.token_version !== input.claims.tokenVersion) {
      throw AUTH_ERRORS.UNAUTHORIZED();
    }
    if (profile.org_status !== "APPROVED" || !profile.email_verified) {
      throw AUTH_ERRORS.UNAUTHORIZED();
    }

    return {
      userId: profile.user_id,
      orgId: profile.org_id,
      email: profile.email,
      role: profile.role,
      tokenVersion: profile.token_version,
    };
  }

  public assertActionAllowed(action: AuthAction, sensitiveReauthRequired: boolean): void {
    if (
      (action === "ROTATE_SESSION" || action === "REVOKE_ALL_SESSIONS") &&
      sensitiveReauthRequired
    ) {
      throw AUTH_ERRORS.SENSITIVE_REAUTH_REQUIRED();
    }
  }

  private parseClaims(token: string, expectedKind: "access" | "refresh"): AuthClaims {
    const claims = verifyToken(token, expectedKind, {
      jwtSecret: this.jwtSecret,
      issuer: this.issuer,
    });
    if (!claims) {
      throw AUTH_ERRORS.FORCE_REAUTH();
    }
    return claims;
  }

  private async appendAuditWithDedup(
    tx: PoolClient,
    event: Parameters<AuthRepository["appendAuditEvent"]>[1],
  ): Promise<void> {
    if (event.severity === "CRITICAL") {
      await this.repository.appendAuditEvent(tx, event);
      return;
    }

    const dedupKey = [
      event.eventType,
      event.userId ?? "none",
      event.orgId ?? "none",
      event.ipAddress ?? "none",
    ].join("|");

    const repeatCount = await this.repository.upsertAuditDedupCounter(tx, {
      dedupKey,
      windowSeconds: 60,
      now: this.now(),
      shardCount: DEFAULT_AUDIT_DEDUP_SHARD_COUNT,
    });

    if (repeatCount === 1 || repeatCount % 10 === 0) {
      await this.repository.appendAuditEvent(tx, {
        ...event,
        metadata: { ...event.metadata, dedup_repeat_count: repeatCount },
      });
    }
  }

  private isCandidateAllowed(candidate: {
    org_status: string;
    email_verified: boolean;
    deactivated_at: Date | null;
    locked_until: Date | null;
  }): boolean {
    if (candidate.org_status !== "APPROVED") {
      return false;
    }
    if (!candidate.email_verified) {
      return false;
    }
    if (candidate.deactivated_at) {
      return false;
    }
    if (candidate.locked_until && candidate.locked_until > this.now()) {
      return false;
    }
    return true;
  }

  private isSessionTupleConsistent(session: RefreshSession, claims: AuthClaims): boolean {
    return (
      session.user_id === claims.userId &&
      session.id === claims.sessionId &&
      session.session_family_id === claims.sessionFamilyId &&
      session.org_id === claims.orgId
    );
  }

  private async handleRefreshReuse(
    tx: PoolClient,
    sourceSession: RefreshSession,
    reason: string,
    requestMeta: AuthRequestMeta,
  ): Promise<never> {
    await this.repository.revokeSessionFamily(
      tx,
      sourceSession.user_id,
      sourceSession.session_family_id,
      "TOKEN_REUSE_DETECTED",
    );
    await this.repository.incrementTokenVersion(tx, sourceSession.user_id);

    await this.repository.appendAuditEvent(tx, {
      eventType: "TOKEN_REUSE_DETECTED",
      severity: "CRITICAL",
      userId: sourceSession.user_id,
      orgId: sourceSession.org_id,
      sessionId: sourceSession.id,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: { reason },
    });
    await this.repository.appendAuditEvent(tx, {
      eventType: "CRITICAL_SECURITY_EVENT",
      severity: "CRITICAL",
      userId: sourceSession.user_id,
      orgId: sourceSession.org_id,
      sessionId: sourceSession.id,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: { category: "refresh_reuse", reason },
    });

    throw AUTH_ERRORS.FORCE_REAUTH();
  }

  private async lockAndTrimSessionsBeforeInsert(
    tx: PoolClient,
    userId: string,
    forLogin: boolean,
  ): Promise<void> {
    const activeSessions = await this.repository.lockActiveSessionsForUser(tx, userId);
    const maxBeforeInsert = forLogin
      ? this.maxActiveSessions - 1
      : this.maxActiveSessions;

    if (activeSessions.length <= maxBeforeInsert) {
      return;
    }

    const toRevoke = activeSessions
      .slice(0, activeSessions.length - maxBeforeInsert)
      .map((session) => session.id);
    await this.repository.revokeSessionsByIds(
      tx,
      toRevoke,
      forLogin ? "SESSION_CAP_EVICTION_LOGIN" : "SESSION_CAP_EVICTION_REFRESH",
    );
  }

  private async enforceSessionCap(
    tx: PoolClient,
    userId: string,
    maxActiveSessions: number,
  ): Promise<void> {
    const activeSessions = await this.repository.lockActiveSessionsForUser(tx, userId);
    if (activeSessions.length <= maxActiveSessions) {
      return;
    }

    const toRevoke = activeSessions
      .slice(0, activeSessions.length - maxActiveSessions)
      .map((session) => session.id);
    await this.repository.revokeSessionsByIds(tx, toRevoke, "SESSION_CAP_POST_ENFORCEMENT");
  }

  private syncMemoryLimiter(counterKey: string, decision: RateLimitDecision): void {
    if (decision.blocked) {
      this.rateLimiter.markBlocked(counterKey, decision.blockedUntil);
    }
  }

  private ipPrefix(ipAddress: string | null): string {
    if (!ipAddress) {
      return "unknown";
    }
    const ip = ipAddress.trim();
    if (ip.includes(":")) {
      return `v6:${ip.split(":").slice(0, 4).join(":")}`;
    }
    const parts = ip.split(".");
    if (parts.length !== 4) {
      return "unknown";
    }
    return `v4:${parts.slice(0, 3).join(".")}`;
  }

  private async updateBehaviorAndRisk(
    tx: PoolClient,
    sourceSession: RefreshSession,
    now: Date,
    isDeviceMismatch: boolean,
    isIpChurn: boolean,
    additionalSignals: RiskSignal[],
  ): Promise<{ sensitiveReauthRequired: boolean }> {
    await this.repository.upsertBehaviorBucket(tx, {
      sessionId: sourceSession.id,
      now,
      refreshDelta: 1,
      deviceMismatchDelta: isDeviceMismatch ? 1 : 0,
      ipChurnDelta: isIpChurn ? 1 : 0,
    });

    const metrics = await this.repository.getBehaviorMetrics(tx, sourceSession.id, now);
    const current = await this.repository.getRiskStateForUpdate(tx, sourceSession.id, now);

    const signals: RiskSignal[] = [...additionalSignals];
    if (isDeviceMismatch) {
      signals.push({ signal: "device_mismatch", weight: 5, confidence: 0.9, persistent: true });
    }
    if (isIpChurn && metrics.ip_churn_30m >= 4) {
      signals.push({ signal: "ip_churn", weight: 2, confidence: 0.4 });
    }
    if (
      metrics.refresh_1m > DEFAULT_BURST_REFRESH_PER_MINUTE ||
      metrics.refresh_5m > DEFAULT_BURST_REFRESH_PER_FIVE_MIN
    ) {
      signals.push({ signal: "refresh_burst", weight: 3, confidence: 0.7 });
    }

    let baseline = current.baseline_refresh_interval_seconds;
    let baselineConfidence = current.baseline_confidence;
    const rawIntervalSeconds =
      current.last_refresh_at === null
        ? null
        : Math.max(0, (now.getTime() - current.last_refresh_at.getTime()) / 1000);
    const intervalSeconds =
      rawIntervalSeconds === null
        ? null
        : Math.min(
            DEFAULT_MAX_REFRESH_INTERVAL_SECONDS,
            Math.max(DEFAULT_MIN_REFRESH_INTERVAL_SECONDS, rawIntervalSeconds),
          );
    const freezeBaseline =
      current.effective_risk_score >= DEFAULT_BASELINE_FREEZE_EFFECTIVE_RISK_THRESHOLD ||
      current.sensitive_reauth_required;

    if (intervalSeconds !== null && !freezeBaseline) {
      baseline =
        baseline === null
          ? intervalSeconds
          : DEFAULT_EWMA_ALPHA * intervalSeconds + (1 - DEFAULT_EWMA_ALPHA) * baseline;
      baselineConfidence = Math.min(1, baselineConfidence + 0.2);
    }

    if (
      intervalSeconds !== null &&
      baseline !== null &&
      baseline > 0 &&
      baselineConfidence >= 1 &&
      intervalSeconds / baseline < DEFAULT_BASELINE_DEVIATION_RATIO_THRESHOLD
    ) {
      signals.push({ signal: "baseline_deviation", weight: 3, confidence: 0.6 });
    }

    let transientRiskScore = current.transient_risk_score;
    let persistentRiskScore = current.persistent_risk_score;
    let confidenceScore = current.confidence_score;
    let lastDecayAt = current.last_decay_at ?? now;
    const sessionAgeRiskMultiplier = this.getSessionAgeRiskMultiplier(sourceSession.issued_at, now);
    let transientDecaySteps = 0;
    let persistentDecaySteps = 0;

    if (signals.length === 0) {
      const elapsedMinutes = (now.getTime() - lastDecayAt.getTime()) / (60 * 1000);
      transientDecaySteps = Math.floor(elapsedMinutes / DEFAULT_TRANSIENT_DECAY_MINUTES);
      persistentDecaySteps = Math.floor(elapsedMinutes / DEFAULT_PERSISTENT_DECAY_MINUTES);
      if (transientDecaySteps > 0) {
        transientRiskScore = Math.max(0, transientRiskScore - transientDecaySteps);
      }
      if (persistentDecaySteps > 0) {
        persistentRiskScore = Math.max(0, persistentRiskScore - persistentDecaySteps);
      }
      if (transientDecaySteps > 0 || persistentDecaySteps > 0) {
        lastDecayAt = now;
      }
      confidenceScore = Math.max(0, confidenceScore * 0.98);
    } else {
      const averageConfidence =
        signals.reduce((sum, signal) => sum + signal.confidence, 0) / signals.length;
      confidenceScore = Math.min(1, Math.max(0, confidenceScore * 0.7 + averageConfidence * 0.3));
      for (const signal of signals) {
        const weightedContribution = signal.weight * sessionAgeRiskMultiplier;
        if (signal.persistent) {
          persistentRiskScore += weightedContribution;
        } else {
          transientRiskScore += weightedContribution;
        }
      }
    }

    const riskScore = transientRiskScore + persistentRiskScore;
    const effectiveRiskScore = riskScore * confidenceScore;
    let riskLevel: "LOW" | "MEDIUM" | "HIGH" = "LOW";
    if (effectiveRiskScore >= 14) {
      riskLevel = "HIGH";
    } else if (effectiveRiskScore >= 8) {
      riskLevel = "MEDIUM";
    }

    const hasCriticalSignal = signals.some((signal) => signal.critical === true);
    let sensitiveReauthRequired =
      current.sensitive_reauth_required ||
      effectiveRiskScore >= 8 ||
      persistentRiskScore >= 5;
    if (
      !hasCriticalSignal &&
      effectiveRiskScore < 6 &&
      transientRiskScore <= 0 &&
      persistentRiskScore <= 1 &&
      (transientDecaySteps > 0 || persistentDecaySteps > 0)
    ) {
      sensitiveReauthRequired = false;
    }

    await this.repository.saveRiskState(tx, {
      sessionId: sourceSession.id,
      riskScore,
      transientRiskScore,
      persistentRiskScore,
      confidenceScore,
      effectiveRiskScore,
      riskLevel,
      sensitiveReauthRequired,
      baselineRefreshIntervalSeconds: baseline,
      baselineConfidence,
      lastRefreshAt: now,
      lastDecayAt,
      lastAnomalyAt: signals.length > 0 ? now : current.last_anomaly_at,
      anomalyReasons: {
        signals: signals.map((signal) => signal.signal),
        freeze_baseline: freezeBaseline,
        session_age_multiplier: sessionAgeRiskMultiplier,
        transient_risk_score: transientRiskScore,
        persistent_risk_score: persistentRiskScore,
        refresh_1m: metrics.refresh_1m,
        refresh_5m: metrics.refresh_5m,
        mismatch_30m: metrics.mismatch_30m,
        ip_churn_30m: metrics.ip_churn_30m,
      },
    });

    if (isDeviceMismatch) {
      await this.appendAuditWithDedup(tx, {
        eventType: "CRITICAL_SECURITY_EVENT",
        severity: "WARNING",
        userId: sourceSession.user_id,
        orgId: sourceSession.org_id,
        sessionId: sourceSession.id,
        ipAddress: sourceSession.ip_address,
        userAgent: sourceSession.user_agent,
        metadata: { reason: "device_mismatch_signal" },
      });
    }

    return { sensitiveReauthRequired };
  }

  private getSessionAgeRiskMultiplier(sessionIssuedAt: Date, now: Date): number {
    const ageMs = Math.max(0, now.getTime() - sessionIssuedAt.getTime());
    const ageHours = ageMs / (60 * 60 * 1000);
    if (ageHours < 1) {
      return 1.25;
    }
    if (ageHours < 24) {
      return 1.1;
    }
    if (ageHours >= 24 * 7) {
      return 0.9;
    }
    return 1;
  }

  private getEpochBumpDryRunRiskLevel(impact: EpochBumpImpact): EpochBumpDryRunRiskLevel {
    if (
      impact.affected_sessions >= 50000 ||
      impact.affected_users >= 20000 ||
      impact.affected_orgs >= 100
    ) {
      return "HIGH";
    }

    if (
      impact.affected_sessions >= 1000 ||
      impact.affected_users >= 500 ||
      impact.affected_orgs >= 10
    ) {
      return "MEDIUM";
    }

    return "LOW";
  }
}

export type { LoginInput, LogoutInput, MeInput, RefreshInput, RegisterInput };
