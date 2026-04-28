import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";

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

describe("Organization lifecycle integration", () => {
  let pool: Pool;
  let tx: PoolClient;
  let app: ReturnType<typeof createAuthApp>;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL);
  });

  beforeEach(async () => {
    tx = await beginIsolatedTestTransaction(pool);
    const repository = new AuthRepository();
    const service = new AuthService({
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

  async function loginAs(role: "admin" | "viewer" = "admin"): Promise<{
    accessToken: string;
    userId: string;
    orgId: string;
  }> {
    const user = await seedApprovedUser(tx, { role });
    const login = await request(app).post("/auth/login").send({
      orgId: user.orgId,
      email: user.email,
      password: user.password,
    });
    expect(login.status).toBe(200);
    return {
      accessToken: String(login.body.accessToken),
      userId: user.userId,
      orgId: user.orgId,
    };
  }

  async function createOrg(status: "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED"): Promise<string> {
    const result = await tx.query<{ id: string }>(
      `
      INSERT INTO organizations (name, status, rejection_reason, suspended_at, deactivated_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
      `,
      [
        `Org-${status}-${randomUUID()}`,
        status,
        status === "REJECTED" ? "Previously rejected reason" : null,
        status === "SUSPENDED" ? new Date() : null,
        status === "SUSPENDED" || status === "REJECTED" ? new Date() : null,
      ],
    );
    return result.rows[0].id;
  }

  it("enforces admin-only pending listing", async () => {
    const admin = await loginAs("admin");
    const viewer = await loginAs("viewer");
    await createOrg("PENDING");

    const allowed = await request(app)
      .get("/orgs/pending")
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(allowed.status).toBe(200);

    const denied = await request(app)
      .get("/orgs/pending")
      .set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("FORBIDDEN_ACTION");
  });

  it("applies pending pagination defaults and max cap", async () => {
    const admin = await loginAs("admin");
    const before = await request(app)
      .get("/orgs/pending")
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(before.status).toBe(200);

    await createOrg("PENDING");
    await createOrg("PENDING");
    await createOrg("APPROVED");

    const defaults = await request(app)
      .get("/orgs/pending")
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(defaults.status).toBe(200);
    expect(defaults.body.page).toBe(1);
    expect(defaults.body.pageSize).toBe(25);
    expect(defaults.body.total).toBe(before.body.total + 2);
    expect(defaults.body.items.every((item: { status: string }) => item.status === "PENDING")).toBe(
      true,
    );

    const capped = await request(app)
      .get("/orgs/pending?page=1&pageSize=500")
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(capped.status).toBe(200);
    expect(capped.body.pageSize).toBe(100);
  });

  it("handles valid transitions with correct status normalization", async () => {
    const admin = await loginAs("admin");
    const reason = "This lifecycle action has valid rationale.";

    const pendingForApprove = await createOrg("PENDING");
    const approve = await request(app)
      .post(`/orgs/${pendingForApprove}/approve`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason });
    expect(approve.status).toBe(200);
    const approvedRow = await tx.query<{
      status: string;
      rejection_reason: string | null;
      suspended_at: Date | null;
      deactivated_at: Date | null;
    }>(
      "SELECT status, rejection_reason, suspended_at, deactivated_at FROM organizations WHERE id = $1",
      [pendingForApprove],
    );
    expect(approvedRow.rows[0].status).toBe("APPROVED");
    expect(approvedRow.rows[0].rejection_reason).toBeNull();
    expect(approvedRow.rows[0].suspended_at).toBeNull();
    expect(approvedRow.rows[0].deactivated_at).toBeNull();

    const pendingForReject = await createOrg("PENDING");
    const reject = await request(app)
      .post(`/orgs/${pendingForReject}/reject`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason });
    expect(reject.status).toBe(200);
    const rejectedRow = await tx.query<{
      status: string;
      rejection_reason: string | null;
      suspended_at: Date | null;
      deactivated_at: Date | null;
    }>(
      "SELECT status, rejection_reason, suspended_at, deactivated_at FROM organizations WHERE id = $1",
      [pendingForReject],
    );
    expect(rejectedRow.rows[0].status).toBe("REJECTED");
    expect(rejectedRow.rows[0].rejection_reason).toBe(reason.trim());
    expect(rejectedRow.rows[0].suspended_at).toBeNull();
    expect(rejectedRow.rows[0].deactivated_at).not.toBeNull();

    const approvedForSuspend = await createOrg("APPROVED");
    const suspend = await request(app)
      .post(`/orgs/${approvedForSuspend}/suspend`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason });
    expect(suspend.status).toBe(200);
    const suspendedRow = await tx.query<{
      status: string;
      rejection_reason: string | null;
      suspended_at: Date | null;
      deactivated_at: Date | null;
    }>(
      "SELECT status, rejection_reason, suspended_at, deactivated_at FROM organizations WHERE id = $1",
      [approvedForSuspend],
    );
    expect(suspendedRow.rows[0].status).toBe("SUSPENDED");
    expect(suspendedRow.rows[0].rejection_reason).toBeNull();
    expect(suspendedRow.rows[0].suspended_at).not.toBeNull();
    expect(suspendedRow.rows[0].deactivated_at).not.toBeNull();

    const suspendedForReactivate = await createOrg("SUSPENDED");
    const reactivate = await request(app)
      .post(`/orgs/${suspendedForReactivate}/reactivate`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason });
    expect(reactivate.status).toBe(200);
    const reactivatedRow = await tx.query<{
      status: string;
      rejection_reason: string | null;
      suspended_at: Date | null;
      deactivated_at: Date | null;
    }>(
      "SELECT status, rejection_reason, suspended_at, deactivated_at FROM organizations WHERE id = $1",
      [suspendedForReactivate],
    );
    expect(reactivatedRow.rows[0].status).toBe("APPROVED");
    expect(reactivatedRow.rows[0].rejection_reason).toBeNull();
    expect(reactivatedRow.rows[0].suspended_at).toBeNull();
    expect(reactivatedRow.rows[0].deactivated_at).toBeNull();
  });

  it("returns 409 for invalid lifecycle transitions", async () => {
    const admin = await loginAs("admin");
    const reason = "This lifecycle action has valid rationale.";
    const cases: Array<{ status: "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED"; action: string }> = [
      { status: "PENDING", action: "suspend" },
      { status: "APPROVED", action: "reject" },
      { status: "REJECTED", action: "approve" },
      { status: "SUSPENDED", action: "reject" },
    ];

    for (const testCase of cases) {
      const orgId = await createOrg(testCase.status);
      const response = await request(app)
        .post(`/orgs/${orgId}/${testCase.action}`)
        .set("Authorization", `Bearer ${admin.accessToken}`)
        .send({ reason });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("CONFLICT");
    }
  });

  it("validates reasons for lifecycle actions", async () => {
    const admin = await loginAs("admin");
    const orgId = await createOrg("PENDING");

    const empty = await request(app)
      .post(`/orgs/${orgId}/approve`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason: "   " });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe("INVALID_REASON");

    const tooShort = await request(app)
      .post(`/orgs/${orgId}/approve`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason: "too short" });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.code).toBe("INVALID_REASON");

    const tooLong = await request(app)
      .post(`/orgs/${orgId}/approve`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason: "a".repeat(2001) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe("INVALID_REASON");
  });

  it("writes audit rows for every lifecycle action with required metadata", async () => {
    const admin = await loginAs("admin");
    const reason = "  Valid lifecycle reason for audit metadata.  ";

    const pendingForApprove = await createOrg("PENDING");
    const pendingForReject = await createOrg("PENDING");
    const approvedForSuspend = await createOrg("APPROVED");
    const suspendedForReactivate = await createOrg("SUSPENDED");

    const calls = [
      { orgId: pendingForApprove, action: "approve", eventType: "ORG_APPROVED" },
      { orgId: pendingForReject, action: "reject", eventType: "ORG_REJECTED" },
      { orgId: approvedForSuspend, action: "suspend", eventType: "ORG_SUSPENDED" },
      { orgId: suspendedForReactivate, action: "reactivate", eventType: "ORG_REACTIVATED" },
    ] as const;

    for (const call of calls) {
      const response = await request(app)
        .post(`/orgs/${call.orgId}/${call.action}`)
        .set("Authorization", `Bearer ${admin.accessToken}`)
        .send({ reason });
      expect(response.status).toBe(200);
    }

    for (const call of calls) {
      const audit = await tx.query<{ metadata: Record<string, unknown> }>(
        `
        SELECT metadata
        FROM auth_audit_logs
        WHERE event_type = $1
          AND metadata->>'target_org_id' = $2
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [call.eventType, call.orgId],
      );
      expect(audit.rows).toHaveLength(1);
      const metadata = audit.rows[0].metadata;
      expect(metadata.old_status).toBeDefined();
      expect(metadata.new_status).toBeDefined();
      expect(metadata.reason).toBe(String(reason.trim()));
      expect(metadata.actor_user_id).toBe(String(admin.userId));
      expect(metadata.actor_org_id).toBe(String(admin.orgId));
      expect(metadata.target_org_id).toBe(String(call.orgId));
      expect(metadata.timestamp).toBeDefined();
      expect(metadata.request_ip).toBeDefined();
      expect(metadata.user_agent).toBeDefined();
    }
  });

  it("returns FORBIDDEN_ACTION for non-admin lifecycle mutations", async () => {
    const viewer = await loginAs("viewer");
    const orgId = await createOrg("PENDING");

    const response = await request(app)
      .post(`/orgs/${orgId}/approve`)
      .set("Authorization", `Bearer ${viewer.accessToken}`)
      .send({ reason: "Reason that is definitely long enough." });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("FORBIDDEN_ACTION");
  });
});
