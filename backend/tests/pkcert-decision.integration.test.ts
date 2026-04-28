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
const VALID_REASON =
  "The submission package has completed PKCERT intake review and the decision is recorded for governance.";

type LoginResult = {
  accessToken: string;
  userId: string;
  orgId: string;
};

type SeededSubmitted = {
  cycleId: string;
  packageId: string;
  submissionId: string;
};

describe("PKCERT decision integration", () => {
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
    role: "admin" | "viewer" = "viewer",
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
  ): Promise<void> {
    await tx.query(
      `
      INSERT INTO pkcert_users (user_id, pkcert_role, is_active)
      VALUES ($1, $2, TRUE)
      `,
      [userId, role],
    );
  }

  async function seedSubmitted(
    orgId: string,
    userId: string,
    options?: { intakeStatus?: "PENDING_INTAKE" | "IN_INTAKE_REVIEW" | "INTAKE_REVIEWED" },
  ): Promise<SeededSubmitted> {
    const finalizedAt = new Date("2026-04-26T10:00:00.000Z");
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
      VALUES ($1, $2, 'Ready for decision tests.', TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, $3, $4, $5)
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
      hashes: { manifestHashAlgorithm: "SHA-256" },
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
        `SUB-20260426-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
        JSON.stringify(manifest),
        manifestHashFor(manifest),
        userId,
        finalizedAt,
      ],
    );

    const submitted = await request(app)
      .post(`/submission-packages/${pkg.rows[0].id}/submit`)
      .set("Authorization", `Bearer ${(await tokenForUser(orgId, userId)).accessToken}`)
      .send({});
    expect(submitted.status).toBe(201);

    const status = options?.intakeStatus ?? "INTAKE_REVIEWED";
    if (status === "PENDING_INTAKE") {
      await tx.query(
        `
        UPDATE pkcert_intake_reviews
        SET assigned_to_user_id = NULL,
            assigned_at = NULL,
            started_by_user_id = NULL,
            started_at = NULL,
            reviewed_by_user_id = NULL,
            reviewed_at = NULL,
            status = 'PENDING_INTAKE'
        WHERE external_submission_id = $1
        `,
        [submitted.body.id],
      );
    } else if (status === "IN_INTAKE_REVIEW") {
      await tx.query(
        `
        UPDATE pkcert_intake_reviews
        SET assigned_to_user_id = $2,
            assigned_at = now(),
            started_by_user_id = $2,
            started_at = now(),
            reviewed_by_user_id = NULL,
            reviewed_at = NULL,
            status = 'IN_INTAKE_REVIEW'
        WHERE external_submission_id = $1
        `,
        [submitted.body.id, userId],
      );
    } else {
      await tx.query(
        `
        UPDATE pkcert_intake_reviews
        SET assigned_to_user_id = $2,
            assigned_at = now(),
            started_by_user_id = $2,
            started_at = now(),
            reviewed_by_user_id = $2,
            reviewed_at = now(),
            internal_notes = 'Internal notes must not be exposed to organization users.',
            status = 'INTAKE_REVIEWED'
        WHERE external_submission_id = $1
        `,
        [submitted.body.id, userId],
      );
    }

    return {
      cycleId: cycle.rows[0].id,
      packageId: pkg.rows[0].id,
      submissionId: submitted.body.id,
    };
  }

  async function tokenForUser(orgId: string, userId: string): Promise<LoginResult> {
    const user = await tx.query<{ email: string }>(
      `
      SELECT email
      FROM users
      WHERE id = $1
      `,
      [userId],
    );
    const login = await request(app).post("/auth/login").send({
      orgId,
      email: user.rows[0].email,
      password: "Password!234",
    });
    expect(login.status).toBe(200);
    return { accessToken: String(login.body.accessToken), userId, orgId };
  }

  async function recordDecision(
    token: string,
    submissionId: string,
    decision = "ACCEPTED",
    decisionReason = VALID_REASON,
  ) {
    return request(app)
      .post(`/pkcert/intake/submissions/${submissionId}/decision`)
      .set("Authorization", `Bearer ${token}`)
      .send({ decision, decisionReason });
  }

  it("records valid decisions without mutating submission, package, intake, or readiness state", async () => {
    const orgAdmin = await loginAs("admin");
    const pkcertAdmin = await loginAs("admin");
    await addPkcertUser(pkcertAdmin.userId, "PKCERT_ADMIN");
    const seeded = await seedSubmitted(orgAdmin.orgId, orgAdmin.userId);

    const created = await recordDecision(
      pkcertAdmin.accessToken,
      seeded.submissionId,
      "RETURNED_FOR_CORRECTION",
      "The submission package needs correction because required material was not sufficient for this intake decision.",
    );
    expect(created.status).toBe(201);
    expect(created.body.decision).toBe("RETURNED_FOR_CORRECTION");
    expect(created.body.externalSubmissionId).toBe(seeded.submissionId);
    expect(created.body.internalNotes).toBe("Internal notes must not be exposed to organization users.");

    const states = await tx.query<{
      submission_status: string;
      package_status: string;
      intake_status: string;
      readiness_count: string;
    }>(
      `
      SELECT
        es.status AS submission_status,
        p.status AS package_status,
        pir.status AS intake_status,
        count(asr.id)::text AS readiness_count
      FROM external_submissions es
      JOIN assessment_submission_packages p ON p.id = es.submission_package_id
      JOIN pkcert_intake_reviews pir ON pir.external_submission_id = es.id
      LEFT JOIN assessment_submission_readiness asr ON asr.assessment_cycle_id = es.assessment_cycle_id
      WHERE es.id = $1
      GROUP BY es.status, p.status, pir.status
      `,
      [seeded.submissionId],
    );
    expect(states.rows[0]).toMatchObject({
      submission_status: "SUBMITTED",
      package_status: "CREATED",
      intake_status: "INTAKE_REVIEWED",
      readiness_count: "1",
    });
  });

  it("supports accepted and rejected decisions for separate reviewed submissions", async () => {
    const orgAdmin = await loginAs("admin");
    const pkcertAdmin = await loginAs("admin");
    await addPkcertUser(pkcertAdmin.userId, "PKCERT_ADMIN");
    const accepted = await seedSubmitted(orgAdmin.orgId, orgAdmin.userId);
    const rejected = await seedSubmitted(orgAdmin.orgId, orgAdmin.userId);

    const acceptedResponse = await recordDecision(
      pkcertAdmin.accessToken,
      accepted.submissionId,
      "ACCEPTED",
      "The submitted package is accepted after intake review was completed successfully.",
    );
    const rejectedResponse = await recordDecision(
      pkcertAdmin.accessToken,
      rejected.submissionId,
      "REJECTED",
      "The submitted package is rejected because it does not satisfy the intake requirements.",
    );
    expect(acceptedResponse.status).toBe(201);
    expect(acceptedResponse.body.decision).toBe("ACCEPTED");
    expect(rejectedResponse.status).toBe(201);
    expect(rejectedResponse.body.decision).toBe("REJECTED");
  });

  it("enforces PKCERT decision authorization and input validation", async () => {
    const orgAdmin = await loginAs("admin");
    const orgViewer = await createUserInOrg(orgAdmin.orgId, "viewer");
    const pkcertAdmin = await loginAs("admin");
    const pkcertReviewer = await loginAs("viewer");
    await addPkcertUser(pkcertAdmin.userId, "PKCERT_ADMIN");
    await addPkcertUser(pkcertReviewer.userId, "PKCERT_REVIEWER");
    const seeded = await seedSubmitted(orgAdmin.orgId, orgAdmin.userId);

    const orgDenied = await recordDecision(orgAdmin.accessToken, seeded.submissionId);
    expect(orgDenied.status).toBe(403);
    expect(orgDenied.body.code).toBe("PKCERT_ACCESS_REQUIRED");

    const orgViewerDenied = await recordDecision(orgViewer.accessToken, seeded.submissionId);
    expect(orgViewerDenied.status).toBe(403);
    expect(orgViewerDenied.body.code).toBe("PKCERT_ACCESS_REQUIRED");

    const reviewerDenied = await recordDecision(pkcertReviewer.accessToken, seeded.submissionId);
    expect(reviewerDenied.status).toBe(403);
    expect(reviewerDenied.body.code).toBe("FORBIDDEN_ACTION");

    const invalidDecision = await recordDecision(
      pkcertAdmin.accessToken,
      seeded.submissionId,
      "APPROVED",
      VALID_REASON,
    );
    expect(invalidDecision.status).toBe(400);
    expect(invalidDecision.body.code).toBe("INVALID_PKCERT_DECISION");

    const shortReason = await recordDecision(
      pkcertAdmin.accessToken,
      seeded.submissionId,
      "ACCEPTED",
      "too short",
    );
    expect(shortReason.status).toBe(400);
    expect(shortReason.body.code).toBe("INVALID_PKCERT_DECISION");
  });

  it("blocks decisions unless submission is submitted and intake is reviewed, and prevents duplicates", async () => {
    const orgAdmin = await loginAs("admin");
    const pkcertAdmin = await loginAs("admin");
    await addPkcertUser(pkcertAdmin.userId, "PKCERT_ADMIN");
    const pending = await seedSubmitted(orgAdmin.orgId, orgAdmin.userId, {
      intakeStatus: "PENDING_INTAKE",
    });
    const inReview = await seedSubmitted(orgAdmin.orgId, orgAdmin.userId, {
      intakeStatus: "IN_INTAKE_REVIEW",
    });
    const reviewed = await seedSubmitted(orgAdmin.orgId, orgAdmin.userId);

    const pendingDecision = await recordDecision(pkcertAdmin.accessToken, pending.submissionId);
    expect(pendingDecision.status).toBe(409);
    expect(pendingDecision.body.code).toBe("PKCERT_DECISION_REQUIRES_INTAKE_REVIEWED");

    const inReviewDecision = await recordDecision(pkcertAdmin.accessToken, inReview.submissionId);
    expect(inReviewDecision.status).toBe(409);
    expect(inReviewDecision.body.code).toBe("PKCERT_DECISION_REQUIRES_INTAKE_REVIEWED");

    const withdrawn = await request(app)
      .post(`/external-submissions/${reviewed.submissionId}/withdraw`)
      .set("Authorization", `Bearer ${orgAdmin.accessToken}`)
      .send({ reason: "Withdrawing before decision creation is still allowed." });
    expect(withdrawn.status).toBe(200);

    const withdrawnDecision = await recordDecision(pkcertAdmin.accessToken, reviewed.submissionId);
    expect(withdrawnDecision.status).toBe(409);
    expect(withdrawnDecision.body.code).toBe("EXTERNAL_SUBMISSION_WITHDRAWN");

    const fresh = await seedSubmitted(orgAdmin.orgId, orgAdmin.userId);
    const created = await recordDecision(pkcertAdmin.accessToken, fresh.submissionId);
    expect(created.status).toBe(201);
    const duplicate = await recordDecision(pkcertAdmin.accessToken, fresh.submissionId);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe("PKCERT_DECISION_ALREADY_EXISTS");
  });

  it("allows PKCERT and organization reads with different visibility and blocks cross-org reads", async () => {
    const orgAdmin = await loginAs("admin");
    const orgViewer = await createUserInOrg(orgAdmin.orgId, "viewer");
    const otherOrgAdmin = await loginAs("admin");
    const pkcertAdmin = await loginAs("admin");
    const pkcertReviewer = await loginAs("viewer");
    await addPkcertUser(pkcertAdmin.userId, "PKCERT_ADMIN");
    await addPkcertUser(pkcertReviewer.userId, "PKCERT_REVIEWER");
    const seeded = await seedSubmitted(orgAdmin.orgId, orgAdmin.userId);
    const created = await recordDecision(pkcertAdmin.accessToken, seeded.submissionId);
    expect(created.status).toBe(201);

    const pkcertRead = await request(app)
      .get(`/pkcert/intake/submissions/${seeded.submissionId}/decision`)
      .set("Authorization", `Bearer ${pkcertReviewer.accessToken}`);
    expect(pkcertRead.status).toBe(200);
    expect(pkcertRead.body.internalNotes).toBe("Internal notes must not be exposed to organization users.");
    expect(pkcertRead.body.intakeStatus).toBe("INTAKE_REVIEWED");

    const orgRead = await request(app)
      .get(`/external-submissions/${seeded.submissionId}/decision`)
      .set("Authorization", `Bearer ${orgViewer.accessToken}`);
    expect(orgRead.status).toBe(200);
    expect(orgRead.body).toMatchObject({
      decision: "ACCEPTED",
      externalSubmissionId: seeded.submissionId,
      submissionPackageId: seeded.packageId,
      assessmentCycleId: seeded.cycleId,
    });
    expect(orgRead.body.internalNotes).toBeUndefined();
    expect(orgRead.body.intakeStatus).toBeUndefined();
    expect(orgRead.body.decidedByUserId).toBeUndefined();

    const crossOrg = await request(app)
      .get(`/external-submissions/${seeded.submissionId}/decision`)
      .set("Authorization", `Bearer ${otherOrgAdmin.accessToken}`);
    expect(crossOrg.status).toBe(404);
  });

  it("does not audit reads, audits decision creation, and blocks withdrawal after decision", async () => {
    const orgAdmin = await loginAs("admin");
    const orgViewer = await createUserInOrg(orgAdmin.orgId, "viewer");
    const pkcertAdmin = await loginAs("admin");
    await addPkcertUser(pkcertAdmin.userId, "PKCERT_ADMIN");
    const seeded = await seedSubmitted(orgAdmin.orgId, orgAdmin.userId);

    const created = await recordDecision(pkcertAdmin.accessToken, seeded.submissionId);
    expect(created.status).toBe(201);

    const withdrawal = await request(app)
      .post(`/external-submissions/${seeded.submissionId}/withdraw`)
      .set("Authorization", `Bearer ${orgAdmin.accessToken}`)
      .send({ reason: "Withdrawal after decision should be blocked." });
    expect(withdrawal.status).toBe(409);
    expect(withdrawal.body.code).toBe("EXTERNAL_SUBMISSION_DECIDED");

    const beforeReadAudit = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type = 'PKCERT_DECISION_RECORDED'
      `,
    );

    await request(app)
      .get(`/external-submissions/${seeded.submissionId}/decision`)
      .set("Authorization", `Bearer ${orgViewer.accessToken}`);
    await request(app)
      .get(`/pkcert/intake/submissions/${seeded.submissionId}/decision`)
      .set("Authorization", `Bearer ${pkcertAdmin.accessToken}`);

    const afterReadAudit = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type = 'PKCERT_DECISION_RECORDED'
      `,
    );
    expect(afterReadAudit.rows[0].count).toBe(beforeReadAudit.rows[0].count);

    const audit = await tx.query<{ metadata: Record<string, unknown> }>(
      `
      SELECT metadata
      FROM auth_audit_logs
      WHERE event_type = 'PKCERT_DECISION_RECORDED'
      `,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata).toMatchObject({
      org_id: orgAdmin.orgId,
      external_submission_id: seeded.submissionId,
      decision_id: created.body.id,
      decision: "ACCEPTED",
      decision_reason: VALID_REASON,
      submission_package_id: seeded.packageId,
      assessment_cycle_id: seeded.cycleId,
      actor_user_id: pkcertAdmin.userId,
      actor_org_id: pkcertAdmin.orgId,
      pkcert_role: "PKCERT_ADMIN",
    });
    expect(audit.rows[0].metadata).toHaveProperty("intake_review_id");
  });
});
