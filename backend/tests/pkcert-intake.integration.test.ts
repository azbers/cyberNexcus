import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import { createAuthApp } from "../src/auth/app.js";
import { AuthRepository } from "../src/auth/repository.js";
import { AuthService } from "../src/auth/service.js";
import { createPool } from "../src/db/pool.js";
import { manifestHashFor } from "../src/submission-package/service.js";
import {
  beginIsolatedTestTransaction,
  DEFAULT_TEST_DATABASE_URL,
  rollbackAndRelease,
  seedApprovedUser,
} from "./test-db.js";

const TEST_JWT_SECRET = "test-jwt-secret";
const DECLARATION =
  "I confirm that the information provided in this assessment is accurate to the best of my knowledge and that the evidence has been reviewed internally.";

type LoginResult = {
  accessToken: string;
  userId: string;
  orgId: string;
};

type SeededPackage = {
  cycleId: string;
  packageId: string;
};

describe("PKCERT intake integration", () => {
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

  async function loginAs(role: "admin" | "viewer" = "admin"): Promise<LoginResult> {
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
    };
  }

  async function createUserInOrg(
    orgId: string,
    role: "admin" | "viewer" = "admin",
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
    };
  }

  async function addPkcertUser(
    userId: string,
    role: "PKCERT_ADMIN" | "PKCERT_REVIEWER",
    isActive = true,
  ): Promise<void> {
    await tx.query(
      `
      INSERT INTO pkcert_users (user_id, pkcert_role, is_active)
      VALUES ($1, $2, $3)
      `,
      [userId, role, isActive],
    );
  }

  async function seedPackage(orgId: string, userId: string): Promise<SeededPackage> {
    const finalizedAt = new Date("2026-04-25T10:00:00.000Z");
    const cycle = await tx.query<{ id: string }>(
      `
      INSERT INTO assessment_cycles (
        org_id,
        status,
        created_by_user_id,
        finalized_internal_by_user_id,
        finalized_internal_at
      )
      VALUES ($1, 'READY_FOR_SUBMISSION', $2, $2, $3)
      RETURNING id
      `,
      [orgId, userId, finalizedAt],
    );
    const readiness = await tx.query<{ id: string }>(
      `
      INSERT INTO assessment_submission_readiness (
        org_id,
        assessment_cycle_id,
        review_notes,
        confirmed_assessment_complete,
        confirmed_evidence_attached,
        confirmed_evidence_reviewed,
        confirmed_score_reviewed,
        confirmed_authorized_submitter,
        confirmed_information_accurate,
        declaration_text,
        declared_by_user_id,
        declared_at
      )
      VALUES ($1, $2, 'Ready for intake.', TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, $3, $4, $5)
      RETURNING id
      `,
      [orgId, cycle.rows[0].id, DECLARATION, userId, finalizedAt],
    );
    const score = await tx.query<{ id: string }>(
      `
      INSERT INTO assessment_score_snapshots (
        assessment_cycle_id,
        org_id,
        overall_score,
        overall_label,
        total_requirements,
        applicable_requirements,
        not_applicable_requirements,
        fully_compliant_count,
        calculated_by_user_id,
        calculated_at
      )
      VALUES ($1, $2, 100, 'COMPLIANT', 1, 1, 0, 1, $3, $4)
      RETURNING id
      `,
      [cycle.rows[0].id, orgId, userId, finalizedAt],
    );
    const manifest = {
      packageVersion: "SUBMISSION_PACKAGE_V1",
      orgId,
      assessmentCycleId: cycle.rows[0].id,
      scoreSnapshotId: score.rows[0].id,
      readinessId: readiness.rows[0].id,
      createdAt: finalizedAt.toISOString(),
      createdByUserId: userId,
      assessmentStatus: "READY_FOR_SUBMISSION",
      scoringVersion: "SCORING_V1",
      overallScore: 100,
      overallLabel: "COMPLIANT",
      counts: {
        totalRequirements: 1,
        applicableRequirements: 1,
        notApplicableRequirements: 0,
        evidenceFiles: 0,
        checklists: 0,
      },
      hashes: {
        manifestHashAlgorithm: "SHA-256",
      },
    };
    const pkg = await tx.query<{ id: string }>(
      `
      INSERT INTO assessment_submission_packages (
        org_id,
        assessment_cycle_id,
        score_snapshot_id,
        readiness_id,
        package_number,
        status,
        manifest_json,
        manifest_hash,
        created_by_user_id,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, 'CREATED', $6::jsonb, $7, $8, $9)
      RETURNING id
      `,
      [
        orgId,
        cycle.rows[0].id,
        score.rows[0].id,
        readiness.rows[0].id,
        `SUB-20260425-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
        JSON.stringify(manifest),
        manifestHashFor(manifest),
        userId,
        finalizedAt,
      ],
    );
    return { cycleId: cycle.rows[0].id, packageId: pkg.rows[0].id };
  }

  async function submitPackage(accessToken: string, packageId: string) {
    return request(app)
      .post(`/submission-packages/${packageId}/submit`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({});
  }

  it("auto-creates pending intake and system audit when an external submission is created", async () => {
    const orgAdmin = await loginAs("admin");
    const seeded = await seedPackage(orgAdmin.orgId, orgAdmin.userId);

    const submitted = await submitPackage(orgAdmin.accessToken, seeded.packageId);
    expect(submitted.status).toBe(201);

    const intake = await tx.query<{ status: string; external_submission_id: string }>(
      `
      SELECT status, external_submission_id
      FROM pkcert_intake_reviews
      WHERE external_submission_id = $1
      `,
      [submitted.body.id],
    );
    expect(intake.rows).toHaveLength(1);
    expect(intake.rows[0]).toMatchObject({
      status: "PENDING_INTAKE",
      external_submission_id: submitted.body.id,
    });

    const audit = await tx.query<{ metadata: Record<string, unknown> }>(
      `
      SELECT metadata
      FROM auth_audit_logs
      WHERE event_type = 'PKCERT_INTAKE_CREATED'
      `,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata).toMatchObject({
      actor_type: "SYSTEM",
      actor_user_id: null,
      actor_org_id: null,
      pkcert_role: null,
      triggered_by_user_id: orgAdmin.userId,
      triggered_by_org_id: orgAdmin.orgId,
      trigger_event: "EXTERNAL_SUBMISSION_CREATED",
    });
  });

  it("blocks org users and inactive PKCERT users from intake routes", async () => {
    const orgAdmin = await loginAs("admin");
    const inactivePkcert = await loginAs("admin");
    await addPkcertUser(inactivePkcert.userId, "PKCERT_ADMIN", false);

    const orgDenied = await request(app)
      .get("/pkcert/intake/submissions")
      .set("Authorization", `Bearer ${orgAdmin.accessToken}`);
    expect(orgDenied.status).toBe(403);
    expect(orgDenied.body.code).toBe("PKCERT_ACCESS_REQUIRED");

    const inactiveDenied = await request(app)
      .get("/pkcert/intake/submissions")
      .set("Authorization", `Bearer ${inactivePkcert.accessToken}`);
    expect(inactiveDenied.status).toBe(403);
    expect(inactiveDenied.body.code).toBe("PKCERT_ACCESS_REQUIRED");
  });

  it("allows PKCERT admin to list, read, assign, start, review, and update notes", async () => {
    const orgAdmin = await loginAs("admin");
    const pkcertAdmin = await loginAs("admin");
    const reviewer = await loginAs("viewer");
    await addPkcertUser(pkcertAdmin.userId, "PKCERT_ADMIN");
    await addPkcertUser(reviewer.userId, "PKCERT_REVIEWER");
    const seeded = await seedPackage(orgAdmin.orgId, orgAdmin.userId);
    const submitted = await submitPackage(orgAdmin.accessToken, seeded.packageId);
    expect(submitted.status).toBe(201);

    const list = await request(app)
      .get("/pkcert/intake/submissions?status=PENDING_INTAKE&pageSize=100")
      .set("Authorization", `Bearer ${pkcertAdmin.accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].externalSubmissionId).toBe(submitted.body.id);

    const read = await request(app)
      .get(`/pkcert/intake/submissions/${submitted.body.id}`)
      .set("Authorization", `Bearer ${pkcertAdmin.accessToken}`);
    expect(read.status).toBe(200);
    expect(read.body.externalSubmissionId).toBe(submitted.body.id);

    const assigned = await request(app)
      .post(`/pkcert/intake/submissions/${submitted.body.id}/assign`)
      .set("Authorization", `Bearer ${pkcertAdmin.accessToken}`)
      .send({ reviewerUserId: reviewer.userId });
    expect(assigned.status).toBe(200);
    expect(assigned.body.status).toBe("PENDING_INTAKE");
    expect(assigned.body.assignedToUserId).toBe(reviewer.userId);

    const started = await request(app)
      .post(`/pkcert/intake/submissions/${submitted.body.id}/start`)
      .set("Authorization", `Bearer ${pkcertAdmin.accessToken}`)
      .send({});
    expect(started.status).toBe(200);
    expect(started.body.status).toBe("IN_INTAKE_REVIEW");

    const notes = await request(app)
      .put(`/pkcert/intake/submissions/${submitted.body.id}/notes`)
      .set("Authorization", `Bearer ${pkcertAdmin.accessToken}`)
      .send({ internalNotes: "Submission is ready for later decision workflow." });
    expect(notes.status).toBe(200);
    expect(notes.body.internalNotes).toBe("Submission is ready for later decision workflow.");

    const reviewed = await request(app)
      .post(`/pkcert/intake/submissions/${submitted.body.id}/mark-reviewed`)
      .set("Authorization", `Bearer ${pkcertAdmin.accessToken}`)
      .send({});
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.status).toBe("INTAKE_REVIEWED");
  });

  it("allows assigned PKCERT reviewer mutations and rejects unassigned reviewer mutations", async () => {
    const orgAdmin = await loginAs("admin");
    const pkcertAdmin = await loginAs("admin");
    const assignedReviewer = await loginAs("viewer");
    const unassignedReviewer = await loginAs("viewer");
    await addPkcertUser(pkcertAdmin.userId, "PKCERT_ADMIN");
    await addPkcertUser(assignedReviewer.userId, "PKCERT_REVIEWER");
    await addPkcertUser(unassignedReviewer.userId, "PKCERT_REVIEWER");
    const seeded = await seedPackage(orgAdmin.orgId, orgAdmin.userId);
    const submitted = await submitPackage(orgAdmin.accessToken, seeded.packageId);
    expect(submitted.status).toBe(201);

    const reviewerList = await request(app)
      .get("/pkcert/intake/submissions")
      .set("Authorization", `Bearer ${assignedReviewer.accessToken}`);
    expect(reviewerList.status).toBe(200);

    const unassignedStart = await request(app)
      .post(`/pkcert/intake/submissions/${submitted.body.id}/start`)
      .set("Authorization", `Bearer ${unassignedReviewer.accessToken}`)
      .send({});
    expect(unassignedStart.status).toBe(403);
    expect(unassignedStart.body.code).toBe("PKCERT_INTAKE_NOT_ASSIGNED");

    const assigned = await request(app)
      .post(`/pkcert/intake/submissions/${submitted.body.id}/assign`)
      .set("Authorization", `Bearer ${pkcertAdmin.accessToken}`)
      .send({ reviewerUserId: assignedReviewer.userId });
    expect(assigned.status).toBe(200);

    const assignedStart = await request(app)
      .post(`/pkcert/intake/submissions/${submitted.body.id}/start`)
      .set("Authorization", `Bearer ${assignedReviewer.accessToken}`)
      .send({});
    expect(assignedStart.status).toBe(200);

    const assignedNotes = await request(app)
      .put(`/pkcert/intake/submissions/${submitted.body.id}/notes`)
      .set("Authorization", `Bearer ${assignedReviewer.accessToken}`)
      .send({ internalNotes: "Assigned reviewer notes." });
    expect(assignedNotes.status).toBe(200);

    const assignedReviewed = await request(app)
      .post(`/pkcert/intake/submissions/${submitted.body.id}/mark-reviewed`)
      .set("Authorization", `Bearer ${assignedReviewer.accessToken}`)
      .send({});
    expect(assignedReviewed.status).toBe(200);
    expect(assignedReviewed.body.reviewedByUserId).toBe(assignedReviewer.userId);
  });

  it("blocks intake mutations after external submission withdrawal but keeps reads available", async () => {
    const orgAdmin = await loginAs("admin");
    const pkcertAdmin = await loginAs("admin");
    await addPkcertUser(pkcertAdmin.userId, "PKCERT_ADMIN");
    const seeded = await seedPackage(orgAdmin.orgId, orgAdmin.userId);
    const submitted = await submitPackage(orgAdmin.accessToken, seeded.packageId);
    expect(submitted.status).toBe(201);

    const withdrawn = await request(app)
      .post(`/external-submissions/${submitted.body.id}/withdraw`)
      .set("Authorization", `Bearer ${orgAdmin.accessToken}`)
      .send({ reason: "Withdrawing before PKCERT intake mutation." });
    expect(withdrawn.status).toBe(200);

    const read = await request(app)
      .get(`/pkcert/intake/submissions/${submitted.body.id}`)
      .set("Authorization", `Bearer ${pkcertAdmin.accessToken}`);
    expect(read.status).toBe(200);
    expect(read.body.externalSubmissionStatus).toBe("WITHDRAWN");

    const start = await request(app)
      .post(`/pkcert/intake/submissions/${submitted.body.id}/start`)
      .set("Authorization", `Bearer ${pkcertAdmin.accessToken}`)
      .send({});
    expect(start.status).toBe(409);
    expect(start.body.code).toBe("EXTERNAL_SUBMISSION_WITHDRAWN");
  });

  it("validates filters and notes length, and does not audit reads", async () => {
    const orgAdmin = await loginAs("admin");
    const pkcertAdmin = await loginAs("admin");
    await addPkcertUser(pkcertAdmin.userId, "PKCERT_ADMIN");
    const seeded = await seedPackage(orgAdmin.orgId, orgAdmin.userId);
    await submitPackage(orgAdmin.accessToken, seeded.packageId);

    const beforeReadAudit = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type LIKE 'PKCERT_INTAKE_%'
      `,
    );

    const invalidFilter = await request(app)
      .get("/pkcert/intake/submissions?status=ACCEPTED")
      .set("Authorization", `Bearer ${pkcertAdmin.accessToken}`);
    expect(invalidFilter.status).toBe(400);
    expect(invalidFilter.body.code).toBe("INVALID_PKCERT_INTAKE_STATUS_FILTER");

    const list = await request(app)
      .get("/pkcert/intake/submissions?assignedToMe=true")
      .set("Authorization", `Bearer ${pkcertAdmin.accessToken}`);
    expect(list.status).toBe(200);

    const afterReadAudit = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type LIKE 'PKCERT_INTAKE_%'
      `,
    );
    expect(afterReadAudit.rows[0].count).toBe(beforeReadAudit.rows[0].count);

    const submitted = await tx.query<{ external_submission_id: string }>(
      `
      SELECT external_submission_id
      FROM pkcert_intake_reviews
      LIMIT 1
      `,
    );
    const tooLongNotes = await request(app)
      .put(`/pkcert/intake/submissions/${submitted.rows[0].external_submission_id}/notes`)
      .set("Authorization", `Bearer ${pkcertAdmin.accessToken}`)
      .send({ internalNotes: "x".repeat(5001) });
    expect(tooLongNotes.status).toBe(400);
    expect(tooLongNotes.body.code).toBe("INVALID_PKCERT_INTAKE_NOTES");
  });

  it("creates audit rows for assignment, start, review, and notes updates", async () => {
    const orgAdmin = await loginAs("admin");
    const pkcertAdmin = await loginAs("admin");
    const reviewer = await loginAs("viewer");
    await addPkcertUser(pkcertAdmin.userId, "PKCERT_ADMIN");
    await addPkcertUser(reviewer.userId, "PKCERT_REVIEWER");
    const seeded = await seedPackage(orgAdmin.orgId, orgAdmin.userId);
    const submitted = await submitPackage(orgAdmin.accessToken, seeded.packageId);
    expect(submitted.status).toBe(201);

    await request(app)
      .post(`/pkcert/intake/submissions/${submitted.body.id}/assign`)
      .set("Authorization", `Bearer ${pkcertAdmin.accessToken}`)
      .send({ reviewerUserId: reviewer.userId });
    await request(app)
      .post(`/pkcert/intake/submissions/${submitted.body.id}/start`)
      .set("Authorization", `Bearer ${pkcertAdmin.accessToken}`)
      .send({});
    await request(app)
      .put(`/pkcert/intake/submissions/${submitted.body.id}/notes`)
      .set("Authorization", `Bearer ${pkcertAdmin.accessToken}`)
      .send({ internalNotes: "Audit metadata notes." });
    await request(app)
      .post(`/pkcert/intake/submissions/${submitted.body.id}/mark-reviewed`)
      .set("Authorization", `Bearer ${pkcertAdmin.accessToken}`)
      .send({});

    const audit = await tx.query<{ event_type: string; metadata: Record<string, unknown> }>(
      `
      SELECT event_type, metadata
      FROM auth_audit_logs
      WHERE event_type IN (
        'PKCERT_INTAKE_ASSIGNED',
        'PKCERT_INTAKE_STARTED',
        'PKCERT_INTAKE_NOTES_UPDATED',
        'PKCERT_INTAKE_REVIEWED'
      )
      ORDER BY created_at ASC
      `,
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual(expect.arrayContaining([
      "PKCERT_INTAKE_ASSIGNED",
      "PKCERT_INTAKE_STARTED",
      "PKCERT_INTAKE_NOTES_UPDATED",
      "PKCERT_INTAKE_REVIEWED",
    ]));
    for (const row of audit.rows) {
      expect(row.metadata).toMatchObject({
        actor_type: "USER",
        actor_user_id: pkcertAdmin.userId,
        actor_org_id: pkcertAdmin.orgId,
        pkcert_role: "PKCERT_ADMIN",
        external_submission_id: submitted.body.id,
      });
    }
    const assignedAudit = audit.rows.find(
      (row) => row.event_type === "PKCERT_INTAKE_ASSIGNED",
    );
    expect(assignedAudit?.metadata).toMatchObject({
      assigned_to_user_id: reviewer.userId,
    });
  });
});
