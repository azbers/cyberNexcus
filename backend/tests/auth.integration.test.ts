import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { Pool, type PoolClient } from "pg";

import { createAuthApp } from "../src/auth/app.js";
import { AuthRepository } from "../src/auth/repository.js";
import { AuthService } from "../src/auth/service.js";
import { createPool } from "../src/db/pool.js";
import {
  beginIsolatedTestTransaction,
  DEFAULT_TEST_DATABASE_URL,
  rollbackAndRelease,
  seedApprovedUser,
} from "./test-db.js";

const TEST_JWT_SECRET = "test-jwt-secret";

describe("Auth integration", () => {
  let pool: Pool;
  let tx: PoolClient;
  let app: ReturnType<typeof createAuthApp>;
  let service: AuthService;
  let repository: AuthRepository;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL);
  });

  beforeEach(async () => {
    tx = await beginIsolatedTestTransaction(pool);
    repository = new AuthRepository();
    service = new AuthService({
      repository,
      jwtSecret: TEST_JWT_SECRET,
    });
    app = createAuthApp({
      pool,
      repository,
      service,
      jwtSecret: TEST_JWT_SECRET,
      txOverride: tx,
    });
  });

  afterEach(async () => {
    await rollbackAndRelease(tx);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function makeEpochRequestConfirmable(requestId: string): Promise<void> {
    await tx.query(
      `
      UPDATE auth_token_epoch_bump_requests
      SET requested_at = now() - interval '5 seconds',
          expires_at = now() + interval '2 minutes',
          updated_at = now()
      WHERE id = $1
        AND status = 'PENDING'
      `,
      [requestId],
    );
  }

  it("returns uniform login failure messages", async () => {
    const seeded = await seedApprovedUser(tx, {
      email: "existing@example.com",
      emailVerified: false,
    });

    const missingUser = await request(app).post("/auth/login").send({
      orgId: seeded.orgId,
      email: "missing@example.com",
      password: "Password!234",
    });
    const policyDenied = await request(app).post("/auth/login").send({
      orgId: seeded.orgId,
      email: seeded.email,
      password: seeded.password,
    });

    expect(missingUser.status).toBe(401);
    expect(policyDenied.status).toBe(401);
    expect(missingUser.body.error).toBe("Invalid email or password");
    expect(policyDenied.body.error).toBe("Invalid email or password");
  });

  it("enforces token_version in middleware on every request", async () => {
    const seeded = await seedApprovedUser(tx);
    const login = await request(app).post("/auth/login").send({
      orgId: seeded.orgId,
      email: seeded.email,
      password: seeded.password,
    });

    expect(login.status).toBe(200);
    const accessToken = String(login.body.accessToken);

    await tx.query("UPDATE users SET token_version = token_version + 1 WHERE id = $1", [
      seeded.userId,
    ]);

    const me = await request(app)
      .get("/auth/me")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(me.status).toBe(401);
  });

  it("refresh reuse revokes family and forces re-authentication", async () => {
    const seeded = await seedApprovedUser(tx);

    const login = await request(app).post("/auth/login").send({
      orgId: seeded.orgId,
      email: seeded.email,
      password: seeded.password,
    });
    expect(login.status).toBe(200);

    const refresh1 = String(login.body.refreshToken);
    const refreshOk = await request(app).post("/auth/refresh").send({
      refreshToken: refresh1,
    });
    expect(refreshOk.status).toBe(200);

    const reused = await request(app).post("/auth/refresh").send({
      refreshToken: refresh1,
    });
    expect(reused.status).toBe(401);
    expect(reused.body.code).toBe("FORCE_REAUTH");

    const version = await tx.query<{ token_version: number }>(
      "SELECT token_version FROM users WHERE id = $1",
      [seeded.userId],
    );
    expect(version.rows[0].token_version).toBe(1);
  });

  it("enforces max 5 active sessions atomically", async () => {
    const seeded = await seedApprovedUser(tx);

    for (let i = 0; i < 7; i += 1) {
      const result = await service.login(tx, {
        orgId: seeded.orgId,
        email: seeded.email,
        password: seeded.password,
      }, {
        ipAddress: "127.0.0.1",
        userAgent: `ua-${i}`,
      });
      expect(result.accessToken.length).toBeGreaterThan(20);
    }

    const active = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM auth_sessions
      WHERE user_id = $1
        AND revoked_at IS NULL
      `,
      [seeded.userId],
    );

    expect(Number(active.rows[0].count)).toBeLessThanOrEqual(5);
  });

  it("requires sensitive re-auth for sensitive actions when risk flag is set", async () => {
    const seeded = await seedApprovedUser(tx);
    const login = await request(app).post("/auth/login").send({
      orgId: seeded.orgId,
      email: seeded.email,
      password: seeded.password,
    });

    expect(login.status).toBe(200);
    const accessToken = String(login.body.accessToken);
    const refreshToken = String(login.body.refreshToken);

    const claims = JSON.parse(
      Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"),
    ) as { sessionId: string };

    await tx.query(
      `
      INSERT INTO auth_session_risk_state (session_id, sensitive_reauth_required, last_decay_at)
      VALUES ($1, TRUE, now())
      ON CONFLICT (session_id)
      DO UPDATE SET sensitive_reauth_required = TRUE
      `,
      [claims.sessionId],
    );

    const logoutAll = await request(app)
      .post("/auth/logout-all")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(logoutAll.status).toBe(403);
    expect(logoutAll.body.code).toBe("SENSITIVE_REAUTH_REQUIRED");

    const refresh = await request(app).post("/auth/refresh").send({ refreshToken });
    expect(refresh.status).toBe(403);
    expect(refresh.body.code).toBe("SENSITIVE_REAUTH_REQUIRED");
  });

  it("rejects invalid refresh JWT before DB session lookup", async () => {
    const lookupSpy = vi.spyOn(repository, "findSessionForRefreshUpdate");
    const response = await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: "invalid.token.value" });

    expect(response.status).toBe(401);
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it("hard cutoff rejects abusive login before DB", async () => {
    const strictApp = createAuthApp({
      pool,
      repository,
      service,
      jwtSecret: TEST_JWT_SECRET,
      txOverride: tx,
      hardCutoffRules: {
        loginIpPerWindow: 0,
        loginUserPerWindow: 0,
        windowMs: 60_000,
      },
    });
    const lookupSpy = vi.spyOn(repository, "findLoginCandidateForUpdate");

    const response = await request(strictApp).post("/auth/login").send({
      orgId: "dummy-org",
      email: "dummy@example.com",
      password: "Password!234",
    });

    expect(response.status).toBe(429);
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it("shards audit dedup counters across shard ids", async () => {
    for (let i = 0; i < 24; i += 1) {
      await repository.upsertAuditDedupCounter(tx, {
        dedupKey: `LOGIN_FAILED|user-${i}|org|127.0.0.1`,
        windowSeconds: 60,
        now: new Date(),
        shardCount: 16,
      });
    }

    const shards = await tx.query<{ count: string }>(
      `
      SELECT count(DISTINCT shard_id)::text AS count
      FROM auth_audit_dedup_counters
      `,
    );

    expect(Number(shards.rows[0].count)).toBeGreaterThan(1);
  });

  it("supports two-step token epoch bump request and confirm with separate audits", async () => {
    const admin = await seedApprovedUser(tx, { role: "admin" });
    const adminLogin = await request(app).post("/auth/login").send({
      orgId: admin.orgId,
      email: admin.email,
      password: admin.password,
    });
    expect(adminLogin.status).toBe(200);
    const accessToken = String(adminLogin.body.accessToken);

    const before = await tx.query<{ token_epoch: Date }>(
      "SELECT token_epoch FROM system_security_state WHERE singleton = TRUE",
    );

    const bumpRequest = await request(app)
      .post("/auth/admin/token-epoch/bump")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ reason: "incident response drill" });
    expect(bumpRequest.status).toBe(202);

    const requestId = String(bumpRequest.body.requestId);
    const confirmationToken = String(bumpRequest.body.confirmationToken);
    await makeEpochRequestConfirmable(requestId);

    const afterRequest = await tx.query<{ token_epoch: Date }>(
      "SELECT token_epoch FROM system_security_state WHERE singleton = TRUE",
    );
    expect(new Date(afterRequest.rows[0].token_epoch).getTime()).toBe(
      new Date(before.rows[0].token_epoch).getTime(),
    );

    const confirm = await request(app)
      .post("/auth/admin/token-epoch/confirm")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ confirmationToken });
    expect(confirm.status).toBe(200);

    const afterConfirm = await tx.query<{ token_epoch: Date }>(
      "SELECT token_epoch FROM system_security_state WHERE singleton = TRUE",
    );
    expect(new Date(afterConfirm.rows[0].token_epoch).getTime()).toBeGreaterThanOrEqual(
      new Date(before.rows[0].token_epoch).getTime(),
    );

    const requestRow = await tx.query<{ status: string }>(
      "SELECT status FROM auth_token_epoch_bump_requests WHERE id = $1",
      [requestId],
    );
    expect(requestRow.rows[0].status).toBe("CONFIRMED");

    const requestedAudit = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type = 'CRITICAL_SECURITY_EVENT'
        AND metadata->>'category' = 'token_epoch_bump_requested'
        AND metadata->>'request_id' = $1
      `,
      [requestId],
    );
    expect(Number(requestedAudit.rows[0].count)).toBe(1);

    const confirmedAudit = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type = 'CRITICAL_SECURITY_EVENT'
        AND metadata->>'category' = 'token_epoch_bump_confirmed'
        AND metadata->>'request_id' = $1
      `,
      [requestId],
    );
    expect(Number(confirmedAudit.rows[0].count)).toBe(1);
  });

  it("rejects epoch bump request without reason", async () => {
    const admin = await seedApprovedUser(tx, { role: "admin" });
    const adminLogin = await request(app).post("/auth/login").send({
      orgId: admin.orgId,
      email: admin.email,
      password: admin.password,
    });
    const accessToken = String(adminLogin.body.accessToken);

    const bump = await request(app)
      .post("/auth/admin/token-epoch/bump")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ reason: "   " });

    expect(bump.status).toBe(400);
    expect(bump.body.code).toBe("EPOCH_BUMP_REASON_REQUIRED");
  });

  it("rejects epoch bump request for non-admin actor", async () => {
    const viewer = await seedApprovedUser(tx, { role: "viewer" });
    const viewerLogin = await request(app).post("/auth/login").send({
      orgId: viewer.orgId,
      email: viewer.email,
      password: viewer.password,
    });
    const accessToken = String(viewerLogin.body.accessToken);

    const bump = await request(app)
      .post("/auth/admin/token-epoch/bump")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ reason: "unauthorized attempt" });

    expect(bump.status).toBe(403);
    expect(bump.body.code).toBe("FORBIDDEN_ACTION");
  });

  it("returns dry-run impact preview without creating request or mutating epoch", async () => {
    const admin = await seedApprovedUser(tx, { role: "admin" });
    const adminLogin = await request(app).post("/auth/login").send({
      orgId: admin.orgId,
      email: admin.email,
      password: admin.password,
    });
    expect(adminLogin.status).toBe(200);
    const accessToken = String(adminLogin.body.accessToken);

    const beforeRequestCount = await tx.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM auth_token_epoch_bump_requests",
    );
    const beforeEpoch = await tx.query<{ token_epoch: Date }>(
      "SELECT token_epoch FROM system_security_state WHERE singleton = TRUE",
    );

    const response = await request(app)
      .post("/auth/admin/token-epoch/bump")
      .query({ dry_run: "true" })
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ reason: "preview global impact" });

    expect(response.status).toBe(200);
    expect(typeof response.body.affected_sessions).toBe("number");
    expect(typeof response.body.affected_users).toBe("number");
    expect(typeof response.body.affected_orgs).toBe("number");
    expect(["LOW", "MEDIUM", "HIGH"]).toContain(response.body.risk_level);

    const afterRequestCount = await tx.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM auth_token_epoch_bump_requests",
    );
    expect(afterRequestCount.rows[0].count).toBe(beforeRequestCount.rows[0].count);

    const afterEpoch = await tx.query<{ token_epoch: Date }>(
      "SELECT token_epoch FROM system_security_state WHERE singleton = TRUE",
    );
    expect(new Date(afterEpoch.rows[0].token_epoch).getTime()).toBe(
      new Date(beforeEpoch.rows[0].token_epoch).getTime(),
    );

    const audit = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type = 'TOKEN_EPOCH_BUMP_DRY_RUN'
        AND metadata->>'reason' = 'preview global impact'
        AND metadata ? 'affected_sessions'
        AND metadata ? 'affected_users'
        AND metadata ? 'affected_orgs'
        AND metadata ? 'risk_level'
        AND metadata ? 'evaluated_at'
        AND metadata ? 'request_ip'
        AND metadata ? 'user_agent'
      `,
    );
    expect(Number(audit.rows[0].count)).toBe(1);
  });

  it("rejects dry-run for non-admin actor", async () => {
    const viewer = await seedApprovedUser(tx, { role: "viewer" });
    const viewerLogin = await request(app).post("/auth/login").send({
      orgId: viewer.orgId,
      email: viewer.email,
      password: viewer.password,
    });
    expect(viewerLogin.status).toBe(200);
    const accessToken = String(viewerLogin.body.accessToken);

    const response = await request(app)
      .post("/auth/admin/token-epoch/bump")
      .query({ dry_run: "true" })
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ reason: "non-admin preview" });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("FORBIDDEN_ACTION");
  });

  it("rejects dry-run when reason is missing", async () => {
    const admin = await seedApprovedUser(tx, { role: "admin" });
    const adminLogin = await request(app).post("/auth/login").send({
      orgId: admin.orgId,
      email: admin.email,
      password: admin.password,
    });
    expect(adminLogin.status).toBe(200);
    const accessToken = String(adminLogin.body.accessToken);

    const response = await request(app)
      .post("/auth/admin/token-epoch/bump")
      .query({ dry_run: "true" })
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ reason: "   " });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("EPOCH_BUMP_REASON_REQUIRED");
  });

  it("rejects invalid epoch bump confirmation token without changing epoch", async () => {
    const admin = await seedApprovedUser(tx, { role: "admin" });
    const adminLogin = await request(app).post("/auth/login").send({
      orgId: admin.orgId,
      email: admin.email,
      password: admin.password,
    });
    const accessToken = String(adminLogin.body.accessToken);

    const before = await tx.query<{ token_epoch: Date }>(
      "SELECT token_epoch FROM system_security_state WHERE singleton = TRUE",
    );

    const confirm = await request(app)
      .post("/auth/admin/token-epoch/confirm")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ confirmationToken: "invalid-token" });

    expect(confirm.status).toBe(401);
    expect(confirm.body.code).toBe("EPOCH_BUMP_CONFIRMATION_INVALID");

    const after = await tx.query<{ token_epoch: Date }>(
      "SELECT token_epoch FROM system_security_state WHERE singleton = TRUE",
    );
    expect(new Date(after.rows[0].token_epoch).getTime()).toBe(
      new Date(before.rows[0].token_epoch).getTime(),
    );
  });

  it("rejects immediate epoch bump request-confirm sequence", async () => {
    const admin = await seedApprovedUser(tx, { role: "admin" });
    const adminLogin = await request(app).post("/auth/login").send({
      orgId: admin.orgId,
      email: admin.email,
      password: admin.password,
    });
    const accessToken = String(adminLogin.body.accessToken);

    const bumpRequest = await request(app)
      .post("/auth/admin/token-epoch/bump")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ reason: "immediate sequence test" });
    expect(bumpRequest.status).toBe(202);

    const confirm = await request(app)
      .post("/auth/admin/token-epoch/confirm")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ confirmationToken: String(bumpRequest.body.confirmationToken) });

    expect(confirm.status).toBe(429);
    expect(confirm.body.code).toBe("EPOCH_BUMP_CONFIRMATION_TOO_SOON");
  });

  it("rejects expired epoch bump confirmation token", async () => {
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const admin = await seedApprovedUser(tx, { role: "admin" });
    const adminLogin = await request(app).post("/auth/login").send({
      orgId: admin.orgId,
      email: admin.email,
      password: admin.password,
    });
    const accessToken = String(adminLogin.body.accessToken);

    const bumpRequest = await request(app)
      .post("/auth/admin/token-epoch/bump")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ reason: "expiry test" });
    expect(bumpRequest.status).toBe(202);

    const requestId = String(bumpRequest.body.requestId);
    const confirmationToken = String(bumpRequest.body.confirmationToken);

    await tx.query(
      `
      UPDATE auth_token_epoch_bump_requests
      SET expires_at = requested_at + interval '1 second'
      WHERE id = $1
      `,
      [requestId],
    );
    await sleep(1100);

    const confirm = await request(app)
      .post("/auth/admin/token-epoch/confirm")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ confirmationToken });

    expect(confirm.status).toBe(401);
    expect(confirm.body.code).toBe("EPOCH_BUMP_CONFIRMATION_EXPIRED");
  });

  it("rejects reused epoch bump confirmation token", async () => {
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const admin = await seedApprovedUser(tx, { role: "admin" });
    const adminLogin = await request(app).post("/auth/login").send({
      orgId: admin.orgId,
      email: admin.email,
      password: admin.password,
    });
    const accessToken = String(adminLogin.body.accessToken);

    const bumpRequest = await request(app)
      .post("/auth/admin/token-epoch/bump")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ reason: "reuse test" });
    expect(bumpRequest.status).toBe(202);
    await makeEpochRequestConfirmable(String(bumpRequest.body.requestId));
    const confirmationToken = String(bumpRequest.body.confirmationToken);

    const firstConfirm = await request(app)
      .post("/auth/admin/token-epoch/confirm")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ confirmationToken });
    expect(firstConfirm.status).toBe(200);

    await sleep(1100);
    const secondLogin = await request(app).post("/auth/login").send({
      orgId: admin.orgId,
      email: admin.email,
      password: admin.password,
    });
    expect(secondLogin.status).toBe(200);
    const secondAccessToken = String(secondLogin.body.accessToken);

    const secondConfirm = await request(app)
      .post("/auth/admin/token-epoch/confirm")
      .set("Authorization", `Bearer ${secondAccessToken}`)
      .send({ confirmationToken });
    expect(secondConfirm.status).toBe(409);
    expect(secondConfirm.body.code).toBe("EPOCH_BUMP_CONFIRMATION_REUSED");
  });

  it("rejects token epoch confirmation by a different admin", async () => {
    const adminA = await seedApprovedUser(tx, { role: "admin" });
    const adminB = await seedApprovedUser(tx, { role: "admin" });

    const adminALogin = await request(app).post("/auth/login").send({
      orgId: adminA.orgId,
      email: adminA.email,
      password: adminA.password,
    });
    const adminBLogin = await request(app).post("/auth/login").send({
      orgId: adminB.orgId,
      email: adminB.email,
      password: adminB.password,
    });

    const adminAToken = String(adminALogin.body.accessToken);
    const adminBToken = String(adminBLogin.body.accessToken);

    const bumpRequest = await request(app)
      .post("/auth/admin/token-epoch/bump")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ reason: "split admin test" });
    expect(bumpRequest.status).toBe(202);

    const confirm = await request(app)
      .post("/auth/admin/token-epoch/confirm")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({ confirmationToken: String(bumpRequest.body.confirmationToken) });

    expect(confirm.status).toBe(403);
    expect(confirm.body.code).toBe("FORBIDDEN_ACTION");
  });

  it("rejects token epoch confirmation with same admin on different session context", async () => {
    const admin = await seedApprovedUser(tx, { role: "admin" });
    const firstLogin = await request(app).post("/auth/login").send({
      orgId: admin.orgId,
      email: admin.email,
      password: admin.password,
    });
    expect(firstLogin.status).toBe(200);
    const firstAccessToken = String(firstLogin.body.accessToken);

    const bumpRequest = await request(app)
      .post("/auth/admin/token-epoch/bump")
      .set("Authorization", `Bearer ${firstAccessToken}`)
      .send({ reason: "context binding test" });
    expect(bumpRequest.status).toBe(202);

    await makeEpochRequestConfirmable(String(bumpRequest.body.requestId));

    const secondLogin = await request(app).post("/auth/login").send({
      orgId: admin.orgId,
      email: admin.email,
      password: admin.password,
    });
    expect(secondLogin.status).toBe(200);
    const secondAccessToken = String(secondLogin.body.accessToken);

    const confirm = await request(app)
      .post("/auth/admin/token-epoch/confirm")
      .set("Authorization", `Bearer ${secondAccessToken}`)
      .send({ confirmationToken: String(bumpRequest.body.confirmationToken) });

    expect(confirm.status).toBe(401);
    expect(confirm.body.code).toBe("EPOCH_BUMP_CONFIRMATION_INVALID");
  });

  it("rate-limits repeated epoch bump confirmations", async () => {
    const admin = await seedApprovedUser(tx, { role: "admin" });
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    const loginAdmin = async (): Promise<string> => {
      const adminLogin = await request(app).post("/auth/login").send({
        orgId: admin.orgId,
        email: admin.email,
        password: admin.password,
      });
      expect(adminLogin.status).toBe(200);
      return String(adminLogin.body.accessToken);
    };

    for (let i = 0; i < 3; i += 1) {
      if (i > 0) {
        await sleep(1100);
      }
      const accessToken = await loginAdmin();
      const bumpRequest = await request(app)
        .post("/auth/admin/token-epoch/bump")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ reason: `planned bump ${i}` });
      expect(bumpRequest.status).toBe(202);
      await makeEpochRequestConfirmable(String(bumpRequest.body.requestId));

      const confirm = await request(app)
        .post("/auth/admin/token-epoch/confirm")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ confirmationToken: String(bumpRequest.body.confirmationToken) });
      expect(confirm.status).toBe(200);
    }

    await sleep(1100);
    const accessToken = await loginAdmin();
    const bumpRequest = await request(app)
      .post("/auth/admin/token-epoch/bump")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ reason: "excessive bump" });
    expect(bumpRequest.status).toBe(202);
    await makeEpochRequestConfirmable(String(bumpRequest.body.requestId));

    const blocked = await request(app)
      .post("/auth/admin/token-epoch/confirm")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ confirmationToken: String(bumpRequest.body.confirmationToken) });

    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("EPOCH_BUMP_RATE_LIMITED");
  }, 20000);

  it("allows only one successful confirmation under concurrent confirm attempts", async () => {
    const admin = await seedApprovedUser(tx, { role: "admin" });
    const adminLogin = await request(app).post("/auth/login").send({
      orgId: admin.orgId,
      email: admin.email,
      password: admin.password,
    });
    expect(adminLogin.status).toBe(200);
    const accessToken = String(adminLogin.body.accessToken);

    const bumpRequest = await request(app)
      .post("/auth/admin/token-epoch/bump")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ reason: "concurrency test" });
    expect(bumpRequest.status).toBe(202);
    await makeEpochRequestConfirmable(String(bumpRequest.body.requestId));

    const confirmationToken = String(bumpRequest.body.confirmationToken);
    const [first, second] = await Promise.all([
      request(app)
        .post("/auth/admin/token-epoch/confirm")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ confirmationToken }),
      request(app)
        .post("/auth/admin/token-epoch/confirm")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ confirmationToken }),
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status !== 200)).toHaveLength(1);
  });
});
