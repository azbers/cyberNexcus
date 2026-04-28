import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
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

type LoginResult = {
  accessToken: string;
  userId: string;
  orgId: string;
  email: string;
  password: string;
};

describe("Assessment integration", () => {
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

  async function loginAs(role: "admin" | "viewer" | "auditor" | "responsible_officer" | "it_security_lead"): Promise<LoginResult> {
    const seeded = await seedApprovedUser(tx, { role });
    const login = await request(app).post("/auth/login").send({
      orgId: seeded.orgId,
      email: seeded.email,
      password: seeded.password,
    });
    expect(login.status).toBe(200);
    return {
      accessToken: String(login.body.accessToken),
      userId: seeded.userId,
      orgId: seeded.orgId,
      email: seeded.email,
      password: seeded.password,
    };
  }

  async function createUserInOrg(
    orgId: string,
    role: "viewer" | "auditor" | "commenter" | "responsible_officer" | "it_security_lead" | "admin",
  ): Promise<LoginResult> {
    const email = `${role}-${randomUUID()}@example.com`;
    const password = "Password!234";
    const hash = await bcrypt.hash(password, 12);

    const user = await tx.query<{ id: string }>(
      `
      INSERT INTO users (org_id, email, password_hash, role, email_verified)
      VALUES ($1, $2, $3, $4, TRUE)
      RETURNING id
      `,
      [orgId, email, hash, role],
    );
    await tx.query(
      `
      INSERT INTO password_history (user_id, password_hash)
      VALUES ($1, $2)
      `,
      [user.rows[0].id, hash],
    );

    const login = await request(app).post("/auth/login").send({
      orgId,
      email,
      password,
    });
    expect(login.status).toBe(200);
    return {
      accessToken: String(login.body.accessToken),
      userId: user.rows[0].id,
      orgId,
      email,
      password,
    };
  }

  async function createDraft(accessToken: string): Promise<string> {
    const response = await request(app)
      .post("/assessments/cycles")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({});
    expect(response.status).toBe(201);
    expect(response.body.cycle.status).toBe("DRAFT");
    expect(Number(response.body.seededItemCount)).toBeGreaterThan(0);
    return String(response.body.cycle.id);
  }

  async function firstItemId(cycleId: string): Promise<string> {
    const row = await tx.query<{ id: string }>(
      `
      SELECT id
      FROM assessment_requirement_items
      WHERE assessment_cycle_id = $1
      ORDER BY requirement_key_snapshot ASC
      LIMIT 1
      `,
      [cycleId],
    );
    return row.rows[0].id;
  }

  function checklistBody(overrides?: Record<string, unknown>) {
    return {
      datedWithin12Months: "YES",
      organizationSpecific: "YES",
      addressesRequirement: "PARTIALLY",
      approvedByAuthority: "PENDING",
      currentlyInForce: "YES",
      evidenceQuality: "MODERATE",
      reviewNotes: "Evidence is mostly relevant, but formal approval remains pending.",
      ...overrides,
    };
  }

  async function upsertChecklist(
    accessToken: string,
    cycleId: string,
    itemId: string,
    body = checklistBody(),
  ) {
    return request(app)
      .put(`/assessments/cycles/${cycleId}/items/${itemId}/evidence-checklist`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send(body);
  }

  async function seedChecklistForRequiredItems(
    cycleId: string,
    userId: string,
  ): Promise<void> {
    await tx.query(
      `
      INSERT INTO assessment_evidence_checklists (
        org_id,
        assessment_cycle_id,
        assessment_requirement_item_id,
        dated_within_12_months,
        organization_specific,
        addresses_requirement,
        approved_by_authority,
        currently_in_force,
        evidence_quality,
        review_notes,
        reviewed_by_user_id,
        reviewed_at
      )
      SELECT
        c.org_id,
        c.id,
        i.id,
        'YES',
        'YES',
        'YES',
        'YES',
        'YES',
        'STRONG',
        'Seeded checklist for finalization.',
        $2,
        now()
      FROM assessment_requirement_items i
      JOIN assessment_cycles c ON c.id = i.assessment_cycle_id
      WHERE i.assessment_cycle_id = $1
        AND i.assessment_status != 'NOT_APPLICABLE'
      ON CONFLICT (assessment_requirement_item_id) DO NOTHING
      `,
      [cycleId, userId],
    );
  }

  it("requires authentication for assessment routes", async () => {
    const response = await request(app).get("/assessments/cycles");
    expect(response.status).toBe(401);
  });

  it("allows draft creation for admin only", async () => {
    const admin = await loginAs("admin");
    const viewer = await createUserInOrg(admin.orgId, "viewer");

    const allowed = await request(app)
      .post("/assessments/cycles")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({});
    expect(allowed.status).toBe(201);

    const denied = await request(app)
      .post("/assessments/cycles")
      .set("Authorization", `Bearer ${viewer.accessToken}`)
      .send({});
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("FORBIDDEN_ACTION");
  });

  it("enforces one draft cycle per organization", async () => {
    const admin = await loginAs("admin");
    await createDraft(admin.accessToken);

    const second = await request(app)
      .post("/assessments/cycles")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("ASSESSMENT_ALREADY_HAS_DRAFT");
  });

  it("allows read access to same-org authenticated users and enforces org isolation", async () => {
    const admin = await loginAs("admin");
    const viewer = await createUserInOrg(admin.orgId, "viewer");
    const otherAdmin = await loginAs("admin");
    const cycleId = await createDraft(admin.accessToken);

    const listViewer = await request(app)
      .get("/assessments/cycles")
      .set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(listViewer.status).toBe(200);
    expect(listViewer.body.total).toBeGreaterThanOrEqual(1);

    const getViewer = await request(app)
      .get(`/assessments/cycles/${cycleId}`)
      .set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(getViewer.status).toBe(200);

    const isolated = await request(app)
      .get(`/assessments/cycles/${cycleId}`)
      .set("Authorization", `Bearer ${otherAdmin.accessToken}`);
    expect(isolated.status).toBe(404);
    expect(isolated.body.code).toBe("ASSESSMENT_CYCLE_NOT_FOUND");
  });

  it("enforces update item role matrix", async () => {
    const admin = await loginAs("admin");
    const officer = await createUserInOrg(admin.orgId, "responsible_officer");
    const itLead = await createUserInOrg(admin.orgId, "it_security_lead");
    const viewer = await createUserInOrg(admin.orgId, "viewer");
    const auditor = await createUserInOrg(admin.orgId, "auditor");
    const commenter = await createUserInOrg(admin.orgId, "commenter");

    const cycleId = await createDraft(admin.accessToken);
    const itemId = await firstItemId(cycleId);

    const officerUpdate = await request(app)
      .patch(`/assessments/cycles/${cycleId}/items/${itemId}`)
      .set("Authorization", `Bearer ${officer.accessToken}`)
      .send({ assessmentStatus: "MOSTLY_COMPLIANT" });
    expect(officerUpdate.status).toBe(200);
    expect(officerUpdate.body.assessment_status).toBe("MOSTLY_COMPLIANT");

    const itLeadUpdate = await request(app)
      .patch(`/assessments/cycles/${cycleId}/items/${itemId}`)
      .set("Authorization", `Bearer ${itLead.accessToken}`)
      .send({ assessmentStatus: "PARTIALLY_COMPLIANT" });
    expect(itLeadUpdate.status).toBe(200);
    expect(itLeadUpdate.body.assessment_status).toBe("PARTIALLY_COMPLIANT");

    const viewerUpdate = await request(app)
      .patch(`/assessments/cycles/${cycleId}/items/${itemId}`)
      .set("Authorization", `Bearer ${viewer.accessToken}`)
      .send({ assessmentStatus: "FULLY_COMPLIANT" });
    expect(viewerUpdate.status).toBe(403);
    expect(viewerUpdate.body.code).toBe("FORBIDDEN_ACTION");

    const auditorUpdate = await request(app)
      .patch(`/assessments/cycles/${cycleId}/items/${itemId}`)
      .set("Authorization", `Bearer ${auditor.accessToken}`)
      .send({ assessmentStatus: "FULLY_COMPLIANT" });
    expect(auditorUpdate.status).toBe(403);
    expect(auditorUpdate.body.code).toBe("FORBIDDEN_ACTION");

    const beforeCommenter = await tx.query<{ assessment_status: string }>(
      `
      SELECT assessment_status
      FROM assessment_requirement_items
      WHERE id = $1
      `,
      [itemId],
    );
    expect(beforeCommenter.rows[0].assessment_status).toBe("PARTIALLY_COMPLIANT");

    const commenterUpdate = await request(app)
      .patch(`/assessments/cycles/${cycleId}/items/${itemId}`)
      .set("Authorization", `Bearer ${commenter.accessToken}`)
      .send({ assessmentStatus: "FULLY_COMPLIANT" });
    expect(commenterUpdate.status).toBe(403);
    expect(commenterUpdate.body.code).toBe("FORBIDDEN_ACTION");

    const afterCommenter = await tx.query<{ assessment_status: string }>(
      `
      SELECT assessment_status
      FROM assessment_requirement_items
      WHERE id = $1
      `,
      [itemId],
    );
    expect(afterCommenter.rows[0].assessment_status).toBe("PARTIALLY_COMPLIANT");
  }, 20000);

  it("blocks finalization while UNASSESSED items remain", async () => {
    const admin = await loginAs("admin");
    const cycleId = await createDraft(admin.accessToken);

    const finalize = await request(app)
      .post(`/assessments/cycles/${cycleId}/finalize-internal`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({});
    expect(finalize.status).toBe(409);
    expect(finalize.body.code).toBe("ASSESSMENT_FINALIZE_BLOCKED_UNASSESSED");
  });

  it("allows finalize for admin only and blocks item updates after finalize", async () => {
    const admin = await loginAs("admin");
    const officer = await createUserInOrg(admin.orgId, "responsible_officer");
    const cycleId = await createDraft(admin.accessToken);

    await tx.query(
      `
      UPDATE assessment_requirement_items
      SET assessment_status = 'NOT_COMPLIANT',
          updated_by_user_id = $2
      WHERE assessment_cycle_id = $1
      `,
      [cycleId, admin.userId],
    );
    await seedChecklistForRequiredItems(cycleId, admin.userId);

    const deniedFinalize = await request(app)
      .post(`/assessments/cycles/${cycleId}/finalize-internal`)
      .set("Authorization", `Bearer ${officer.accessToken}`)
      .send({});
    expect(deniedFinalize.status).toBe(403);
    expect(deniedFinalize.body.code).toBe("FORBIDDEN_ACTION");

    const allowedFinalize = await request(app)
      .post(`/assessments/cycles/${cycleId}/finalize-internal`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({});
    expect(allowedFinalize.status).toBe(200);
    expect(allowedFinalize.body.status).toBe("FINALIZED_INTERNAL");

    const itemId = await firstItemId(cycleId);
    const blockedUpdate = await request(app)
      .patch(`/assessments/cycles/${cycleId}/items/${itemId}`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ assessmentStatus: "FULLY_COMPLIANT" });
    expect(blockedUpdate.status).toBe(409);
    expect(blockedUpdate.body.code).toBe("ASSESSMENT_CYCLE_FINALIZED");
  });

  it("writes immutable audit events for create/update/finalize and not for reads", async () => {
    const admin = await loginAs("admin");
    const beforeRead = await tx.query<{ c: string }>(
      `
      SELECT count(*)::text AS c
      FROM auth_audit_logs
      WHERE event_type IN (
        'ASSESSMENT_DRAFT_CREATED',
        'ASSESSMENT_ITEM_STATUS_UPDATED',
        'ASSESSMENT_INTERNAL_FINALIZED'
      )
      `,
    );

    const read = await request(app)
      .get("/assessments/cycles")
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(read.status).toBe(200);

    const afterRead = await tx.query<{ c: string }>(
      `
      SELECT count(*)::text AS c
      FROM auth_audit_logs
      WHERE event_type IN (
        'ASSESSMENT_DRAFT_CREATED',
        'ASSESSMENT_ITEM_STATUS_UPDATED',
        'ASSESSMENT_INTERNAL_FINALIZED'
      )
      `,
    );
    expect(afterRead.rows[0].c).toBe(beforeRead.rows[0].c);

    const cycleId = await createDraft(admin.accessToken);
    const itemId = await firstItemId(cycleId);

    const updated = await request(app)
      .patch(`/assessments/cycles/${cycleId}/items/${itemId}`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ assessmentStatus: "FULLY_COMPLIANT" });
    expect(updated.status).toBe(200);

    await tx.query(
      `
      UPDATE assessment_requirement_items
      SET assessment_status = 'NOT_COMPLIANT',
          updated_by_user_id = $2
      WHERE assessment_cycle_id = $1
        AND assessment_status = 'UNASSESSED'
      `,
      [cycleId, admin.userId],
    );
    await seedChecklistForRequiredItems(cycleId, admin.userId);

    const finalized = await request(app)
      .post(`/assessments/cycles/${cycleId}/finalize-internal`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({});
    expect(finalized.status).toBe(200);

    const audit = await tx.query<{ event_type: string; count: string }>(
      `
      SELECT event_type, count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type IN (
        'ASSESSMENT_DRAFT_CREATED',
        'ASSESSMENT_ITEM_STATUS_UPDATED',
        'ASSESSMENT_INTERNAL_FINALIZED'
      )
      GROUP BY event_type
      `,
    );
    const map = new Map(audit.rows.map((row) => [row.event_type, Number(row.count)]));
    expect((map.get("ASSESSMENT_DRAFT_CREATED") ?? 0) >= 1).toBe(true);
    expect((map.get("ASSESSMENT_ITEM_STATUS_UPDATED") ?? 0) >= 1).toBe(true);
    expect((map.get("ASSESSMENT_INTERNAL_FINALIZED") ?? 0) >= 1).toBe(true);
  });

  it("supports evidence checklist upsert/read role matrix and audit", async () => {
    const admin = await loginAs("admin");
    const officer = await createUserInOrg(admin.orgId, "responsible_officer");
    const itLead = await createUserInOrg(admin.orgId, "it_security_lead");
    const viewer = await createUserInOrg(admin.orgId, "viewer");
    const commenter = await createUserInOrg(admin.orgId, "commenter");
    const auditor = await createUserInOrg(admin.orgId, "auditor");
    const cycleId = await createDraft(admin.accessToken);
    const itemId = await firstItemId(cycleId);

    const missing = await request(app)
      .get(`/assessments/cycles/${cycleId}/items/${itemId}/evidence-checklist`)
      .set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("EVIDENCE_CHECKLIST_NOT_FOUND");

    const adminPut = await upsertChecklist(admin.accessToken, cycleId, itemId);
    expect(adminPut.status).toBe(200);
    expect(adminPut.body.evidenceQuality).toBe("MODERATE");
    expect(adminPut.body.reviewedByUserId).toBe(admin.userId);

    const viewerGet = await request(app)
      .get(`/assessments/cycles/${cycleId}/items/${itemId}/evidence-checklist`)
      .set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(viewerGet.status).toBe(200);
    expect(viewerGet.body.assessmentRequirementItemId).toBe(itemId);

    const officerPut = await upsertChecklist(
      officer.accessToken,
      cycleId,
      itemId,
      checklistBody({ evidenceQuality: "STRONG" }),
    );
    expect(officerPut.status).toBe(200);
    expect(officerPut.body.evidenceQuality).toBe("STRONG");

    const itLeadPut = await upsertChecklist(
      itLead.accessToken,
      cycleId,
      itemId,
      checklistBody({ evidenceQuality: "WEAK" }),
    );
    expect(itLeadPut.status).toBe(200);
    expect(itLeadPut.body.evidenceQuality).toBe("WEAK");

    for (const denied of [viewer, commenter, auditor]) {
      const response = await upsertChecklist(
        denied.accessToken,
        cycleId,
        itemId,
        checklistBody({ evidenceQuality: "NONE" }),
      );
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("FORBIDDEN_ACTION");
    }

    const audit = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type = 'EVIDENCE_CHECKLIST_UPSERTED'
        AND metadata->>'assessment_requirement_item_id' = $1
      `,
      [itemId],
    );
    expect(Number(audit.rows[0].count)).toBe(3);
  });

  it("rejects invalid evidence checklist input and cross-org access", async () => {
    const admin = await loginAs("admin");
    const otherAdmin = await loginAs("admin");
    const cycleId = await createDraft(admin.accessToken);
    const itemId = await firstItemId(cycleId);

    const invalidEnum = await upsertChecklist(
      admin.accessToken,
      cycleId,
      itemId,
      checklistBody({ evidenceQuality: "EXCELLENT" }),
    );
    expect(invalidEnum.status).toBe(400);
    expect(invalidEnum.body.code).toBe("INVALID_EVIDENCE_CHECKLIST");

    const missingFieldBody = checklistBody();
    delete (missingFieldBody as { approvedByAuthority?: unknown }).approvedByAuthority;
    const missingField = await upsertChecklist(
      admin.accessToken,
      cycleId,
      itemId,
      missingFieldBody,
    );
    expect(missingField.status).toBe(400);
    expect(missingField.body.code).toBe("INVALID_EVIDENCE_CHECKLIST");

    const longNotes = await upsertChecklist(
      admin.accessToken,
      cycleId,
      itemId,
      checklistBody({ reviewNotes: "a".repeat(2001) }),
    );
    expect(longNotes.status).toBe(400);
    expect(longNotes.body.code).toBe("INVALID_EVIDENCE_CHECKLIST");

    const crossOrgRead = await request(app)
      .get(`/assessments/cycles/${cycleId}/items/${itemId}/evidence-checklist`)
      .set("Authorization", `Bearer ${otherAdmin.accessToken}`);
    expect(crossOrgRead.status).toBe(404);

    const crossOrgWrite = await upsertChecklist(otherAdmin.accessToken, cycleId, itemId);
    expect(crossOrgWrite.status).toBe(404);
  });

  it("blocks evidence checklist mutation after finalization and does not audit reads", async () => {
    const admin = await loginAs("admin");
    const cycleId = await createDraft(admin.accessToken);
    const itemId = await firstItemId(cycleId);

    const created = await upsertChecklist(admin.accessToken, cycleId, itemId);
    expect(created.status).toBe(200);

    await tx.query(
      `
      UPDATE assessment_requirement_items
      SET assessment_status = 'NOT_APPLICABLE',
          updated_by_user_id = $2
      WHERE assessment_cycle_id = $1
      `,
      [cycleId, admin.userId],
    );

    const beforeRead = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type = 'EVIDENCE_CHECKLIST_UPSERTED'
      `,
    );
    const read = await request(app)
      .get(`/assessments/cycles/${cycleId}/items/${itemId}/evidence-checklist`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(read.status).toBe(200);
    const afterRead = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type = 'EVIDENCE_CHECKLIST_UPSERTED'
      `,
    );
    expect(afterRead.rows[0].count).toBe(beforeRead.rows[0].count);

    const finalized = await request(app)
      .post(`/assessments/cycles/${cycleId}/finalize-internal`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({});
    expect(finalized.status).toBe(200);

    const blocked = await upsertChecklist(
      admin.accessToken,
      cycleId,
      itemId,
      checklistBody({ evidenceQuality: "STRONG" }),
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("ASSESSMENT_CYCLE_FINALIZED");
  });

  it("requires checklists for non-NOT_APPLICABLE items during finalization", async () => {
    const admin = await loginAs("admin");
    const cycleId = await createDraft(admin.accessToken);

    await tx.query(
      `
      UPDATE assessment_requirement_items
      SET assessment_status = 'NOT_COMPLIANT',
          updated_by_user_id = $2
      WHERE assessment_cycle_id = $1
      `,
      [cycleId, admin.userId],
    );

    const blocked = await request(app)
      .post(`/assessments/cycles/${cycleId}/finalize-internal`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("ASSESSMENT_FINALIZE_BLOCKED_MISSING_EVIDENCE_CHECKLIST");

    await tx.query(
      `
      UPDATE assessment_requirement_items
      SET assessment_status = 'NOT_APPLICABLE',
          updated_by_user_id = $2
      WHERE assessment_cycle_id = $1
      `,
      [cycleId, admin.userId],
    );

    const allowed = await request(app)
      .post(`/assessments/cycles/${cycleId}/finalize-internal`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({});
    expect(allowed.status).toBe(200);
  });
});
