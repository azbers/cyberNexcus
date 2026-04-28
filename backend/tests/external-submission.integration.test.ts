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
const HASH = "d".repeat(64);
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
  packageNumber: string;
};

describe("External submission integration", () => {
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

  async function loginAs(role: "admin" | "viewer"): Promise<LoginResult> {
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
    role: "admin" | "viewer",
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

  async function seedPackage(
    orgId: string,
    userId: string,
    options?: {
      packageStatus?: "CREATED" | "VOIDED";
      cycleStatus?: "DRAFT" | "FINALIZED_INTERNAL" | "READY_FOR_SUBMISSION";
      manifestMismatch?: boolean;
    },
  ): Promise<SeededPackage> {
    const suffix = randomUUID();
    const finalizedAt = new Date("2026-04-25T10:00:00.000Z");
    const cycleStatus = options?.cycleStatus ?? "READY_FOR_SUBMISSION";

    const cycle =
      cycleStatus === "DRAFT"
        ? await tx.query<{ id: string }>(
            `
            INSERT INTO assessment_cycles (org_id, status, created_by_user_id)
            VALUES ($1, 'DRAFT', $2)
            RETURNING id
            `,
            [orgId, userId],
          )
        : await tx.query<{ id: string }>(
            `
            INSERT INTO assessment_cycles (
              org_id,
              status,
              created_by_user_id,
              finalized_internal_by_user_id,
              finalized_internal_at
            )
            VALUES ($1, $2, $3, $3, $4)
            RETURNING id
            `,
            [orgId, cycleStatus, userId, finalizedAt],
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
      VALUES ($1, $2, 'Ready for external intake.', TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, $3, $4, $5)
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
    const packageNumber = `SUB-20260425-${suffix.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const packageStatus = options?.packageStatus ?? "CREATED";
    const pkg =
      packageStatus === "CREATED"
        ? await tx.query<{ id: string }>(
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
              packageNumber,
              JSON.stringify(manifest),
              options?.manifestMismatch ? "a".repeat(64) : manifestHashFor(manifest),
              userId,
              finalizedAt,
            ],
          )
        : await tx.query<{ id: string }>(
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
              created_at,
              voided_by_user_id,
              voided_at,
              void_reason
            )
            VALUES ($1, $2, $3, $4, $5, 'VOIDED', $6::jsonb, $7, $8, $9, $8, $9, 'Voided before external submission.')
            RETURNING id
            `,
            [
              orgId,
              cycle.rows[0].id,
              score.rows[0].id,
              readiness.rows[0].id,
              packageNumber,
              JSON.stringify(manifest),
              manifestHashFor(manifest),
              userId,
              finalizedAt,
            ],
          );

    return {
      cycleId: cycle.rows[0].id,
      packageId: pkg.rows[0].id,
      packageNumber,
    };
  }

  async function submitPackage(accessToken: string, packageId: string) {
    return request(app)
      .post(`/submission-packages/${packageId}/submit`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({});
  }

  async function withdrawSubmission(
    accessToken: string,
    submissionId: string,
    reason: unknown,
  ) {
    return request(app)
      .post(`/external-submissions/${submissionId}/withdraw`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ reason });
  }

  it("submits a valid package without mutating package status", async () => {
    const admin = await loginAs("admin");
    const seeded = await seedPackage(admin.orgId, admin.userId);

    const submitted = await submitPackage(admin.accessToken, seeded.packageId);
    expect(submitted.status).toBe(201);
    expect(submitted.body.status).toBe("SUBMITTED");
    expect(submitted.body.submissionNumber).toMatch(/^EXT-\d{8}-[0-9A-F]{8}$/);
    expect(submitted.body.submissionPackageId).toBe(seeded.packageId);
    expect(submitted.body.assessmentCycleId).toBe(seeded.cycleId);
    expect(submitted.body.submittedByUserId).toBe(admin.userId);

    const pkg = await tx.query<{ status: string }>(
      `
      SELECT status
      FROM assessment_submission_packages
      WHERE id = $1
      `,
      [seeded.packageId],
    );
    expect(pkg.rows[0].status).toBe("CREATED");
  });

  it("enforces submit authorization and submit prerequisite guards", async () => {
    const admin = await loginAs("admin");
    const viewer = await createUserInOrg(admin.orgId, "viewer");

    const valid = await seedPackage(admin.orgId, admin.userId);
    const viewerSubmit = await submitPackage(viewer.accessToken, valid.packageId);
    expect(viewerSubmit.status).toBe(403);
    expect(viewerSubmit.body.code).toBe("FORBIDDEN_ACTION");

    const voided = await seedPackage(admin.orgId, admin.userId, {
      packageStatus: "VOIDED",
    });
    const voidedSubmit = await submitPackage(admin.accessToken, voided.packageId);
    expect(voidedSubmit.status).toBe(409);
    expect(voidedSubmit.body.code).toBe("SUBMISSION_PACKAGE_NOT_SUBMITTABLE");

    const finalizedCycle = await seedPackage(admin.orgId, admin.userId, {
      cycleStatus: "FINALIZED_INTERNAL",
    });
    const wrongCycleStatus = await submitPackage(admin.accessToken, finalizedCycle.packageId);
    expect(wrongCycleStatus.status).toBe(409);
    expect(wrongCycleStatus.body.code).toBe("SUBMISSION_PACKAGE_REQUIRES_READY_FOR_SUBMISSION");

    const mismatch = await seedPackage(admin.orgId, admin.userId, {
      manifestMismatch: true,
    });
    const integrityFailed = await submitPackage(admin.accessToken, mismatch.packageId);
    expect(integrityFailed.status).toBe(409);
    expect(integrityFailed.body.code).toBe("SUBMISSION_PACKAGE_INTEGRITY_FAILED");

    const submitted = await submitPackage(admin.accessToken, valid.packageId);
    expect(submitted.status).toBe(201);
    const duplicate = await submitPackage(admin.accessToken, valid.packageId);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe("EXTERNAL_SUBMISSION_ALREADY_EXISTS");
  });

  it("allows resubmission after withdrawal and keeps withdrawn submissions readable", async () => {
    const admin = await loginAs("admin");
    const viewer = await createUserInOrg(admin.orgId, "viewer");
    const seeded = await seedPackage(admin.orgId, admin.userId);
    const submitted = await submitPackage(admin.accessToken, seeded.packageId);
    expect(submitted.status).toBe(201);

    const withdrawn = await withdrawSubmission(
      admin.accessToken,
      submitted.body.id,
      "Withdrawing the intake record for integration test coverage.",
    );
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.status).toBe("WITHDRAWN");
    expect(withdrawn.body.withdrawnByUserId).toBe(admin.userId);

    const readWithdrawn = await request(app)
      .get(`/external-submissions/${submitted.body.id}`)
      .set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(readWithdrawn.status).toBe(200);
    expect(readWithdrawn.body.status).toBe("WITHDRAWN");

    const resubmitted = await submitPackage(admin.accessToken, seeded.packageId);
    expect(resubmitted.status).toBe(201);
    expect(resubmitted.body.id).not.toBe(submitted.body.id);
  });

  it("enforces withdraw authorization, reason validation, and prevents double withdraw", async () => {
    const admin = await loginAs("admin");
    const viewer = await createUserInOrg(admin.orgId, "viewer");
    const seeded = await seedPackage(admin.orgId, admin.userId);
    const submitted = await submitPackage(admin.accessToken, seeded.packageId);
    expect(submitted.status).toBe(201);

    const viewerWithdraw = await withdrawSubmission(
      viewer.accessToken,
      submitted.body.id,
      "Viewer should not withdraw this external submission.",
    );
    expect(viewerWithdraw.status).toBe(403);
    expect(viewerWithdraw.body.code).toBe("FORBIDDEN_ACTION");

    const invalidReason = await withdrawSubmission(
      admin.accessToken,
      submitted.body.id,
      "short",
    );
    expect(invalidReason.status).toBe(400);
    expect(invalidReason.body.code).toBe("INVALID_EXTERNAL_SUBMISSION_WITHDRAW_REASON");

    const withdrawn = await withdrawSubmission(
      admin.accessToken,
      submitted.body.id,
      "Withdrawal reason is valid and long enough.",
    );
    expect(withdrawn.status).toBe(200);

    const secondWithdraw = await withdrawSubmission(
      admin.accessToken,
      submitted.body.id,
      "Second withdrawal attempt should be rejected.",
    );
    expect(secondWithdraw.status).toBe(409);
  });

  it("allows same-org read and list, blocks cross-org access, and does not audit reads", async () => {
    const admin = await loginAs("admin");
    const viewer = await createUserInOrg(admin.orgId, "viewer");
    const otherAdmin = await loginAs("admin");
    const seeded = await seedPackage(admin.orgId, admin.userId);
    const submitted = await submitPackage(admin.accessToken, seeded.packageId);
    expect(submitted.status).toBe(201);

    const beforeRead = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type IN ('EXTERNAL_SUBMISSION_CREATED', 'EXTERNAL_SUBMISSION_WITHDRAWN')
      `,
    );

    const readById = await request(app)
      .get(`/external-submissions/${submitted.body.id}`)
      .set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(readById.status).toBe(200);
    expect(readById.body.id).toBe(submitted.body.id);

    const listByPackage = await request(app)
      .get(`/submission-packages/${seeded.packageId}/submissions?status=SUBMITTED`)
      .set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(listByPackage.status).toBe(200);
    expect(listByPackage.body.total).toBe(1);
    expect(listByPackage.body.items[0].id).toBe(submitted.body.id);

    const listByCycle = await request(app)
      .get(`/assessments/cycles/${seeded.cycleId}/external-submissions?pageSize=100`)
      .set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(listByCycle.status).toBe(200);
    expect(listByCycle.body.total).toBe(1);

    const invalidFilter = await request(app)
      .get(`/submission-packages/${seeded.packageId}/submissions?status=UNDER_REVIEW`)
      .set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(invalidFilter.status).toBe(400);
    expect(invalidFilter.body.code).toBe("INVALID_EXTERNAL_SUBMISSION_STATUS_FILTER");

    const afterRead = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type IN ('EXTERNAL_SUBMISSION_CREATED', 'EXTERNAL_SUBMISSION_WITHDRAWN')
      `,
    );
    expect(afterRead.rows[0].count).toBe(beforeRead.rows[0].count);

    const crossOrgRead = await request(app)
      .get(`/external-submissions/${submitted.body.id}`)
      .set("Authorization", `Bearer ${otherAdmin.accessToken}`);
    expect(crossOrgRead.status).toBe(404);

    const crossOrgList = await request(app)
      .get(`/submission-packages/${seeded.packageId}/submissions`)
      .set("Authorization", `Bearer ${otherAdmin.accessToken}`);
    expect(crossOrgList.status).toBe(404);

    const crossOrgSubmit = await submitPackage(otherAdmin.accessToken, seeded.packageId);
    expect(crossOrgSubmit.status).toBe(404);

    const crossOrgWithdraw = await withdrawSubmission(
      otherAdmin.accessToken,
      submitted.body.id,
      "Cross org cannot withdraw this submission.",
    );
    expect(crossOrgWithdraw.status).toBe(404);
  });

  it("blocks package void while active submitted intake exists", async () => {
    const admin = await loginAs("admin");
    const seeded = await seedPackage(admin.orgId, admin.userId);
    const submitted = await submitPackage(admin.accessToken, seeded.packageId);
    expect(submitted.status).toBe(201);

    const voided = await request(app)
      .post(`/submission-packages/${seeded.packageId}/void`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason: "Package cannot be voided while submitted." });
    expect(voided.status).toBe(409);
    expect(voided.body.code).toBe("PACKAGE_HAS_ACTIVE_SUBMISSION");
  });

  it("creates audit rows for submit and withdraw with expected metadata", async () => {
    const admin = await loginAs("admin");
    const seeded = await seedPackage(admin.orgId, admin.userId);
    const submitted = await submitPackage(admin.accessToken, seeded.packageId);
    expect(submitted.status).toBe(201);

    const withdrawn = await withdrawSubmission(
      admin.accessToken,
      submitted.body.id,
      "Withdrawing to inspect external submission audit metadata.",
    );
    expect(withdrawn.status).toBe(200);

    const audit = await tx.query<{ event_type: string; metadata: Record<string, unknown> }>(
      `
      SELECT event_type, metadata
      FROM auth_audit_logs
      WHERE event_type IN ('EXTERNAL_SUBMISSION_CREATED', 'EXTERNAL_SUBMISSION_WITHDRAWN')
      ORDER BY created_at ASC
      `,
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      "EXTERNAL_SUBMISSION_CREATED",
      "EXTERNAL_SUBMISSION_WITHDRAWN",
    ]);
    expect(audit.rows[0].metadata).toMatchObject({
      org_id: admin.orgId,
      external_submission_id: submitted.body.id,
      submission_number: submitted.body.submissionNumber,
      submission_package_id: seeded.packageId,
      assessment_cycle_id: seeded.cycleId,
      package_number: seeded.packageNumber,
      actor_user_id: admin.userId,
      actor_org_id: admin.orgId,
    });
    expect(audit.rows[0].metadata).toHaveProperty("manifest_hash");
    expect(audit.rows[1].metadata).toMatchObject({
      org_id: admin.orgId,
      external_submission_id: submitted.body.id,
      submission_number: submitted.body.submissionNumber,
      submission_package_id: seeded.packageId,
      assessment_cycle_id: seeded.cycleId,
      reason: "Withdrawing to inspect external submission audit metadata.",
      actor_user_id: admin.userId,
      actor_org_id: admin.orgId,
    });
  });
});
