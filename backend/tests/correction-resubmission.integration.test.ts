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
const DECLARATION =
  "I confirm that the information provided in this assessment is accurate to the best of my knowledge and that the evidence has been reviewed internally.";
const CORRECTION_REASON =
  "PKCERT returned the submission for correction because evidence for multiple requirements was insufficient.";
const CORRECTION_SUMMARY =
  "Updated evidence and checklist review for the returned assessment package.";

type LoginResult = {
  accessToken: string;
  userId: string;
  orgId: string;
};

type SeededDecision = {
  cycleId: string;
  packageId: string;
  submissionId: string;
  intakeId: string;
  decisionId: string;
};

type OrgRole = "admin" | "auditor" | "commenter" | "viewer" | "responsible_officer" | "it_security_lead";

describe("correction resubmission integration", () => {
  let pool: Pool;
  let tx: PoolClient;
  let app: ReturnType<typeof createAuthApp>;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL);
  });

  beforeEach(async () => {
    tx = await beginIsolatedTestTransaction(pool);
    const repository = new AuthRepository();
    const service = new AuthService({ repository, jwtSecret: TEST_JWT_SECRET });
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

  async function loginAs(role: OrgRole = "admin"): Promise<LoginResult> {
    const seeded = await seedApprovedUser(tx, { role });
    const login = await request(app).post("/auth/login").send({
      orgId: seeded.orgId,
      email: seeded.email,
      password: seeded.password,
    });
    expect(login.status).toBe(200);
    return { accessToken: String(login.body.accessToken), userId: seeded.userId, orgId: seeded.orgId };
  }

  async function createUserInOrg(orgId: string, role: OrgRole): Promise<LoginResult> {
    const email = `${role}-${randomUUID()}@example.com`;
    const password = "Password!234";
    const hash = await bcrypt.hash(password, 12);
    const user = await tx.query<{ id: string }>(
      `INSERT INTO users (org_id, email, password_hash, role, email_verified) VALUES ($1, $2, $3, $4, TRUE) RETURNING id`,
      [orgId, email, hash, role],
    );
    await tx.query(`INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)`, [user.rows[0].id, hash]);
    const login = await request(app).post("/auth/login").send({ orgId, email, password });
    expect(login.status).toBe(200);
    return { accessToken: String(login.body.accessToken), userId: user.rows[0].id, orgId };
  }

  async function seedDecision(
    orgId: string,
    userId: string,
    decision: "ACCEPTED" | "REJECTED" | "RETURNED_FOR_CORRECTION" = "RETURNED_FOR_CORRECTION",
  ): Promise<SeededDecision> {
    const finalizedAt = new Date("2026-04-26T10:00:00.000Z");
    const cycle = await tx.query<{ id: string }>(
      `INSERT INTO assessment_cycles (org_id, status, created_by_user_id, finalized_internal_by_user_id, finalized_internal_at) VALUES ($1, 'READY_FOR_SUBMISSION', $2, $2, $3) RETURNING id`,
      [orgId, userId, finalizedAt],
    );
    const readiness = await tx.query<{ id: string }>(
      `INSERT INTO assessment_submission_readiness (org_id, assessment_cycle_id, review_notes, confirmed_assessment_complete, confirmed_evidence_attached, confirmed_evidence_reviewed, confirmed_score_reviewed, confirmed_authorized_submitter, confirmed_information_accurate, declaration_text, declared_by_user_id, declared_at) VALUES ($1, $2, 'Ready for correction tests.', TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, $3, $4, $5) RETURNING id`,
      [orgId, cycle.rows[0].id, DECLARATION, userId, finalizedAt],
    );
    const score = await tx.query<{ id: string }>(
      `INSERT INTO assessment_score_snapshots (assessment_cycle_id, org_id, overall_score, overall_label, total_requirements, applicable_requirements, not_applicable_requirements, fully_compliant_count, calculated_by_user_id, calculated_at) VALUES ($1, $2, 75, 'SUBSTANTIALLY_COMPLIANT', 1, 1, 0, 1, $3, $4) RETURNING id`,
      [cycle.rows[0].id, orgId, userId, finalizedAt],
    );
    const pkg = await tx.query<{ id: string }>(
      `INSERT INTO assessment_submission_packages (org_id, assessment_cycle_id, score_snapshot_id, readiness_id, package_number, status, manifest_json, manifest_hash, created_by_user_id, created_at) VALUES ($1, $2, $3, $4, $5, 'CREATED', '{}'::jsonb, $6, $7, $8) RETURNING id`,
      [
        orgId,
        cycle.rows[0].id,
        score.rows[0].id,
        readiness.rows[0].id,
        `SUB-20260426-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
        "a".repeat(64),
        userId,
        finalizedAt,
      ],
    );
    const submission = await tx.query<{ id: string }>(
      `INSERT INTO external_submissions (org_id, submission_package_id, assessment_cycle_id, submission_number, status, submitted_by_user_id, submitted_at) VALUES ($1, $2, $3, $4, 'SUBMITTED', $5, $6) RETURNING id`,
      [orgId, pkg.rows[0].id, cycle.rows[0].id, `EXT-20260426-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`, userId, finalizedAt],
    );
    const intake = await tx.query<{ id: string }>(
      `INSERT INTO pkcert_intake_reviews (external_submission_id, org_id, assessment_cycle_id, submission_package_id, status, assigned_to_user_id, assigned_at, started_by_user_id, started_at, reviewed_by_user_id, reviewed_at) VALUES ($1, $2, $3, $4, 'INTAKE_REVIEWED', $5, $6, $5, $6, $5, $6) RETURNING id`,
      [submission.rows[0].id, orgId, cycle.rows[0].id, pkg.rows[0].id, userId, finalizedAt],
    );
    const decisionRow = await tx.query<{ id: string }>(
      `INSERT INTO pkcert_submission_decisions (external_submission_id, intake_review_id, org_id, assessment_cycle_id, submission_package_id, decision, decision_reason, decided_by_user_id, decided_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        submission.rows[0].id,
        intake.rows[0].id,
        orgId,
        cycle.rows[0].id,
        pkg.rows[0].id,
        decision,
        "The PKCERT decision reason is long enough to satisfy validation.",
        userId,
        finalizedAt,
      ],
    );
    return {
      cycleId: cycle.rows[0].id,
      packageId: pkg.rows[0].id,
      submissionId: submission.rows[0].id,
      intakeId: intake.rows[0].id,
      decisionId: decisionRow.rows[0].id,
    };
  }

  it("creates only from returned decisions, blocks active duplicates, and allows recreate after void", async () => {
    const admin = await loginAs("admin");
    const viewer = await createUserInOrg(admin.orgId, "viewer");
    const returned = await seedDecision(admin.orgId, admin.userId);
    const accepted = await seedDecision(admin.orgId, admin.userId, "ACCEPTED");
    const rejected = await seedDecision(admin.orgId, admin.userId, "REJECTED");

    const viewerCreate = await request(app)
      .post(`/external-submissions/${returned.submissionId}/correction-resubmissions`)
      .set("Authorization", `Bearer ${viewer.accessToken}`)
      .send({ correctionReason: CORRECTION_REASON });
    expect(viewerCreate.status).toBe(403);

    const acceptedCreate = await request(app)
      .post(`/external-submissions/${accepted.submissionId}/correction-resubmissions`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ correctionReason: CORRECTION_REASON });
    expect(acceptedCreate.status).toBe(409);
    expect(acceptedCreate.body.code).toBe("CORRECTION_RESUBMISSION_REQUIRES_RETURNED_DECISION");

    const rejectedCreate = await request(app)
      .post(`/external-submissions/${rejected.submissionId}/correction-resubmissions`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ correctionReason: CORRECTION_REASON });
    expect(rejectedCreate.status).toBe(409);
    expect(rejectedCreate.body.code).toBe("CORRECTION_RESUBMISSION_REQUIRES_RETURNED_DECISION");

    const missingDecision = await seedDecision(admin.orgId, admin.userId);
    await tx.query(
      `DELETE FROM pkcert_submission_decisions WHERE id = $1`,
      [missingDecision.decisionId],
    );
    const missingDecisionCreate = await request(app)
      .post(`/external-submissions/${missingDecision.submissionId}/correction-resubmissions`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ correctionReason: CORRECTION_REASON });
    expect(missingDecisionCreate.status).toBe(409);
    expect(missingDecisionCreate.body.code).toBe("CORRECTION_RESUBMISSION_REQUIRES_RETURNED_DECISION");

    const invalidReason = await request(app)
      .post(`/external-submissions/${returned.submissionId}/correction-resubmissions`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ correctionReason: "too short" });
    expect(invalidReason.status).toBe(400);
    expect(invalidReason.body.code).toBe("INVALID_CORRECTION_RESUBMISSION");

    const created = await request(app)
      .post(`/external-submissions/${returned.submissionId}/correction-resubmissions`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ correctionReason: `  ${CORRECTION_REASON}  ` });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("DRAFT");
    expect(created.body.correctionReason).toBe(CORRECTION_REASON);

    const duplicate = await request(app)
      .post(`/external-submissions/${returned.submissionId}/correction-resubmissions`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ correctionReason: CORRECTION_REASON });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe("CORRECTION_RESUBMISSION_ALREADY_EXISTS");

    const voided = await request(app)
      .post(`/correction-resubmissions/${created.body.id}/void`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason: "Correction draft abandoned for replacement." });
    expect(voided.status).toBe(200);
    expect(voided.body.status).toBe("VOIDED");

    const listWithVoided = await request(app)
      .get(`/external-submissions/${returned.submissionId}/correction-resubmissions`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(listWithVoided.status).toBe(200);
    expect(listWithVoided.body.items.map((item: { status: string }) => item.status)).toContain("VOIDED");

    const recreated = await request(app)
      .post(`/external-submissions/${returned.submissionId}/correction-resubmissions`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ correctionReason: CORRECTION_REASON });
    expect(recreated.status).toBe(201);
    expect(recreated.body.status).toBe("DRAFT");
  });

  it("enforces summary, mark-ready, void lifecycle and mutation role rules", async () => {
    const admin = await loginAs("admin");
    const officer = await createUserInOrg(admin.orgId, "responsible_officer");
    const securityLead = await createUserInOrg(admin.orgId, "it_security_lead");
    const commenter = await createUserInOrg(admin.orgId, "commenter");
    const auditor = await createUserInOrg(admin.orgId, "auditor");
    const viewer = await createUserInOrg(admin.orgId, "viewer");
    const seeded = await seedDecision(admin.orgId, admin.userId);

    const created = await request(app)
      .post(`/external-submissions/${seeded.submissionId}/correction-resubmissions`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ correctionReason: CORRECTION_REASON });
    expect(created.status).toBe(201);

    const viewerSummary = await request(app)
      .put(`/correction-resubmissions/${created.body.id}/summary`)
      .set("Authorization", `Bearer ${viewer.accessToken}`)
      .send({ correctionSummary: CORRECTION_SUMMARY });
    expect(viewerSummary.status).toBe(403);

    for (const denied of [commenter, auditor]) {
      const deniedSummary = await request(app)
        .put(`/correction-resubmissions/${created.body.id}/summary`)
        .set("Authorization", `Bearer ${denied.accessToken}`)
        .send({ correctionSummary: CORRECTION_SUMMARY });
      expect(deniedSummary.status).toBe(403);
    }

    const summary = await request(app)
      .put(`/correction-resubmissions/${created.body.id}/summary`)
      .set("Authorization", `Bearer ${officer.accessToken}`)
      .send({ correctionSummary: CORRECTION_SUMMARY });
    expect(summary.status).toBe(200);
    expect(summary.body.correctionSummary).toBe(CORRECTION_SUMMARY);

    const securityLeadSummary = await request(app)
      .put(`/correction-resubmissions/${created.body.id}/summary`)
      .set("Authorization", `Bearer ${securityLead.accessToken}`)
      .send({ correctionSummary: `${CORRECTION_SUMMARY} Security lead reviewed.` });
    expect(securityLeadSummary.status).toBe(200);

    const viewerReady = await request(app)
      .post(`/correction-resubmissions/${created.body.id}/mark-ready`)
      .set("Authorization", `Bearer ${viewer.accessToken}`)
      .send({});
    expect(viewerReady.status).toBe(403);

    const shortSummarySeed = await seedDecision(admin.orgId, admin.userId);
    const shortSummaryCorrection = await request(app)
      .post(`/external-submissions/${shortSummarySeed.submissionId}/correction-resubmissions`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ correctionReason: CORRECTION_REASON });
    expect(shortSummaryCorrection.status).toBe(201);
    await request(app)
      .put(`/correction-resubmissions/${shortSummaryCorrection.body.id}/summary`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ correctionSummary: "too short" })
      .expect(200);
    const shortSummaryReady = await request(app)
      .post(`/correction-resubmissions/${shortSummaryCorrection.body.id}/mark-ready`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({});
    expect(shortSummaryReady.status).toBe(400);
    expect(shortSummaryReady.body.code).toBe("INVALID_CORRECTION_RESUBMISSION");

    const ready = await request(app)
      .post(`/correction-resubmissions/${created.body.id}/mark-ready`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({});
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe("READY_FOR_RESUBMISSION");
    expect(ready.body.readyByUserId).toBe(admin.userId);

    const blockedSummary = await request(app)
      .put(`/correction-resubmissions/${created.body.id}/summary`)
      .set("Authorization", `Bearer ${officer.accessToken}`)
      .send({ correctionSummary: "Another summary update after ready should fail." });
    expect(blockedSummary.status).toBe(409);
    expect(blockedSummary.body.code).toBe("INVALID_CORRECTION_RESUBMISSION_STATUS");

    const viewerVoid = await request(app)
      .post(`/correction-resubmissions/${created.body.id}/void`)
      .set("Authorization", `Bearer ${viewer.accessToken}`)
      .send({ reason: "Viewer cannot void correction." });
    expect(viewerVoid.status).toBe(403);

    const voided = await request(app)
      .post(`/correction-resubmissions/${created.body.id}/void`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason: "Correction attempt voided after internal review." });
    expect(voided.status).toBe(200);
    expect(voided.body.status).toBe("VOIDED");

    const invalidVoidReason = await request(app)
      .post(`/correction-resubmissions/${shortSummaryCorrection.body.id}/void`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason: "short" });
    expect(invalidVoidReason.status).toBe(400);
    expect(invalidVoidReason.body.code).toBe("INVALID_CORRECTION_RESUBMISSION_VOID_REASON");

    const draftVoid = await request(app)
      .post(`/correction-resubmissions/${shortSummaryCorrection.body.id}/void`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason: "Draft correction abandoned." });
    expect(draftVoid.status).toBe(200);
    expect(draftVoid.body.status).toBe("VOIDED");

    const voidAgain = await request(app)
      .post(`/correction-resubmissions/${created.body.id}/void`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason: "Trying to void again should fail." });
    expect(voidAgain.status).toBe(409);
    expect(voidAgain.body.code).toBe("INVALID_CORRECTION_RESUBMISSION_STATUS");
  });

  it("supports same-org reads, blocks cross-org access, does not audit reads, and audits mutations", async () => {
    const admin = await loginAs("admin");
    const sameOrgViewer = await createUserInOrg(admin.orgId, "viewer");
    const otherOrgAdmin = await loginAs("admin");
    const seeded = await seedDecision(admin.orgId, admin.userId);

    const auditBefore = await tx.query<{ count: string }>(
      `SELECT count(*) FROM auth_audit_logs WHERE event_type LIKE 'CORRECTION_RESUBMISSION_%'`,
    );

    const created = await request(app)
      .post(`/external-submissions/${seeded.submissionId}/correction-resubmissions`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ correctionReason: CORRECTION_REASON });
    expect(created.status).toBe(201);

    const list = await request(app)
      .get(`/external-submissions/${seeded.submissionId}/correction-resubmissions`)
      .set("Authorization", `Bearer ${sameOrgViewer.accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);

    const detail = await request(app)
      .get(`/correction-resubmissions/${created.body.id}`)
      .set("Authorization", `Bearer ${sameOrgViewer.accessToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(created.body.id);

    const crossOrg = await request(app)
      .get(`/correction-resubmissions/${created.body.id}`)
      .set("Authorization", `Bearer ${otherOrgAdmin.accessToken}`);
    expect(crossOrg.status).toBe(404);

    const crossOrgCreate = await request(app)
      .post(`/external-submissions/${seeded.submissionId}/correction-resubmissions`)
      .set("Authorization", `Bearer ${otherOrgAdmin.accessToken}`)
      .send({ correctionReason: CORRECTION_REASON });
    expect(crossOrgCreate.status).toBe(404);

    const crossOrgSummary = await request(app)
      .put(`/correction-resubmissions/${created.body.id}/summary`)
      .set("Authorization", `Bearer ${otherOrgAdmin.accessToken}`)
      .send({ correctionSummary: CORRECTION_SUMMARY });
    expect(crossOrgSummary.status).toBe(404);

    await request(app)
      .put(`/correction-resubmissions/${created.body.id}/summary`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ correctionSummary: CORRECTION_SUMMARY })
      .expect(200);
    await request(app)
      .post(`/correction-resubmissions/${created.body.id}/mark-ready`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({})
      .expect(200);

    const auditAfterReads = await tx.query<{ count: string }>(
      `SELECT count(*) FROM auth_audit_logs WHERE event_type LIKE 'CORRECTION_RESUBMISSION_%'`,
    );
    expect(Number(auditAfterReads.rows[0].count) - Number(auditBefore.rows[0].count)).toBe(3);

    const auditEvents = await tx.query<{ event_type: string; metadata: Record<string, unknown> }>(
      `SELECT event_type, metadata FROM auth_audit_logs WHERE event_type LIKE 'CORRECTION_RESUBMISSION_%' ORDER BY created_at`,
    );
    expect(auditEvents.rows.map((row) => row.event_type)).toEqual(
      expect.arrayContaining([
        "CORRECTION_RESUBMISSION_CREATED",
        "CORRECTION_RESUBMISSION_SUMMARY_UPDATED",
        "CORRECTION_RESUBMISSION_MARKED_READY",
      ]),
    );
    expect(auditEvents.rows.at(-1)?.metadata).toMatchObject({
      org_id: admin.orgId,
      correction_resubmission_id: created.body.id,
      original_external_submission_id: seeded.submissionId,
      original_decision_id: seeded.decisionId,
      original_submission_package_id: seeded.packageId,
      original_assessment_cycle_id: seeded.cycleId,
      actor_user_id: admin.userId,
      actor_org_id: admin.orgId,
    });
  });
});
