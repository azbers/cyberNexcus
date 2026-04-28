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

type OrgRole = "admin" | "auditor" | "commenter" | "viewer" | "responsible_officer" | "it_security_lead";

type SeededReadyCorrection = {
  originalCycleId: string;
  originalItemIds: string[];
  correctionId: string;
  decisionId: string;
};

describe("correction execution integration", () => {
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

  async function seedPisfRequirements(count = 2): Promise<Array<{ id: string; key: string; text: string; hash: string }>> {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    const domain = await tx.query<{ id: string }>(
      `INSERT INTO pisf_domains (domain_code, name, source_hash) VALUES ($1, $2, $3) RETURNING id`,
      [`D-${suffix}`, `Domain ${suffix}`, "1".repeat(64)],
    );
    const control = await tx.query<{ id: string }>(
      `INSERT INTO pisf_controls (domain_id, control_code, phase, area, sub_area, title, statement_text, source_statement_text, source_hash) VALUES ($1, $2, 'Govern', 'Area', 'Sub', $3, $4, $4, $5) RETURNING id`,
      [domain.rows[0].id, `C-${suffix}`, `Control ${suffix}`, `Control statement ${suffix}`, "2".repeat(64)],
    );
    const rows: Array<{ id: string; key: string; text: string; hash: string }> = [];
    for (let index = 1; index <= count; index += 1) {
      const key = `REQ-${suffix}-${index}`;
      const text = `Requirement text ${suffix} ${index}`;
      const hash = String(index).repeat(64).slice(0, 64);
      const requirement = await tx.query<{ id: string }>(
        `INSERT INTO pisf_requirements (control_id, requirement_key, ordinal, requirement_text, source_control_text, derivation_method, status, source_hash) VALUES ($1, $2, $3, $4, $5, 'single_statement', 'ACTIVE', $6) RETURNING id`,
        [control.rows[0].id, key, index, text, `Control source ${suffix}`, hash],
      );
      rows.push({ id: requirement.rows[0].id, key, text, hash });
    }
    return rows;
  }

  async function seedReadyCorrection(
    orgId: string,
    userId: string,
    correctionStatus: "DRAFT" | "READY_FOR_RESUBMISSION" | "VOIDED" = "READY_FOR_RESUBMISSION",
    decision: "ACCEPTED" | "REJECTED" | "RETURNED_FOR_CORRECTION" = "RETURNED_FOR_CORRECTION",
  ): Promise<SeededReadyCorrection> {
    const requirements = await seedPisfRequirements(2);
    const finalizedAt = new Date("2026-04-26T10:00:00.000Z");
    const cycle = await tx.query<{ id: string }>(
      `INSERT INTO assessment_cycles (org_id, status, created_by_user_id, finalized_internal_by_user_id, finalized_internal_at) VALUES ($1, 'READY_FOR_SUBMISSION', $2, $2, $3) RETURNING id`,
      [orgId, userId, finalizedAt],
    );
    const originalItemIds: string[] = [];
    for (const [index, requirement] of requirements.entries()) {
      const item = await tx.query<{ id: string }>(
        `INSERT INTO assessment_requirement_items (assessment_cycle_id, pisf_requirement_id, requirement_key_snapshot, requirement_text_snapshot, source_hash_snapshot, assessment_status, updated_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [cycle.rows[0].id, requirement.id, requirement.key, requirement.text, requirement.hash, index === 0 ? "FULLY_COMPLIANT" : "PARTIALLY_COMPLIANT", userId],
      );
      originalItemIds.push(item.rows[0].id);
      await tx.query(
        `INSERT INTO assessment_evidence_checklists (org_id, assessment_cycle_id, assessment_requirement_item_id, dated_within_12_months, organization_specific, addresses_requirement, approved_by_authority, currently_in_force, evidence_quality, reviewed_by_user_id, reviewed_at) VALUES ($1, $2, $3, 'YES', 'YES', 'YES', 'YES', 'YES', 'STRONG', $4, $5)`,
        [orgId, cycle.rows[0].id, item.rows[0].id, userId, finalizedAt],
      );
    }
    await tx.query(
      `INSERT INTO assessment_evidence_files (org_id, assessment_cycle_id, assessment_requirement_item_id, uploaded_by_user_id, original_filename, stored_filename, storage_key, storage_backend, mime_type_detected, file_extension, file_size_bytes, sha256_hash, validation_result_json, status) VALUES ($1, $2, $3, $4, 'original.txt', 'stored.txt', $5, 'LOCAL', 'text/plain', '.txt', 12, $6, '{}'::jsonb, 'UPLOADED')`,
      [orgId, cycle.rows[0].id, originalItemIds[0], userId, `evidence/${randomUUID()}.txt`, "f".repeat(64)],
    );
    const readiness = await tx.query<{ id: string }>(
      `INSERT INTO assessment_submission_readiness (org_id, assessment_cycle_id, review_notes, confirmed_assessment_complete, confirmed_evidence_attached, confirmed_evidence_reviewed, confirmed_score_reviewed, confirmed_authorized_submitter, confirmed_information_accurate, declaration_text, declared_by_user_id, declared_at) VALUES ($1, $2, 'Ready for correction execution tests.', TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, $3, $4, $5) RETURNING id`,
      [orgId, cycle.rows[0].id, DECLARATION, userId, finalizedAt],
    );
    const score = await tx.query<{ id: string }>(
      `INSERT INTO assessment_score_snapshots (assessment_cycle_id, org_id, overall_score, overall_label, total_requirements, applicable_requirements, not_applicable_requirements, partially_compliant_count, fully_compliant_count, calculated_by_user_id, calculated_at) VALUES ($1, $2, 85, 'SUBSTANTIALLY_COMPLIANT', 2, 2, 0, 1, 1, $3, $4) RETURNING id`,
      [cycle.rows[0].id, orgId, userId, finalizedAt],
    );
    const pkg = await tx.query<{ id: string }>(
      `INSERT INTO assessment_submission_packages (org_id, assessment_cycle_id, score_snapshot_id, readiness_id, package_number, status, manifest_json, manifest_hash, created_by_user_id, created_at) VALUES ($1, $2, $3, $4, $5, 'CREATED', '{}'::jsonb, $6, $7, $8) RETURNING id`,
      [orgId, cycle.rows[0].id, score.rows[0].id, readiness.rows[0].id, `SUB-20260426-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`, "a".repeat(64), userId, finalizedAt],
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
      [submission.rows[0].id, intake.rows[0].id, orgId, cycle.rows[0].id, pkg.rows[0].id, decision, "The PKCERT decision reason is long enough to satisfy validation.", userId, finalizedAt],
    );

    const statusColumns =
      correctionStatus === "READY_FOR_RESUBMISSION"
        ? `status, correction_summary, ready_by_user_id, ready_at`
        : correctionStatus === "VOIDED"
          ? `status, voided_by_user_id, voided_at, void_reason`
          : `status`;
    const statusValues =
      correctionStatus === "READY_FOR_RESUBMISSION"
        ? [`READY_FOR_RESUBMISSION`, CORRECTION_SUMMARY, userId, finalizedAt]
        : correctionStatus === "VOIDED"
          ? [`VOIDED`, userId, finalizedAt, "Correction attempt abandoned for test."]
          : [`DRAFT`];
    const placeholders = statusValues.map((_, index) => `$${index + 8}`).join(", ");
    const correction = await tx.query<{ id: string }>(
      `INSERT INTO correction_resubmissions (org_id, original_external_submission_id, original_decision_id, original_submission_package_id, original_assessment_cycle_id, correction_reason, created_by_user_id, ${statusColumns}) VALUES ($1, $2, $3, $4, $5, $6, $7, ${placeholders}) RETURNING id`,
      [orgId, submission.rows[0].id, decisionRow.rows[0].id, pkg.rows[0].id, cycle.rows[0].id, CORRECTION_REASON, userId, ...statusValues],
    );

    return {
      originalCycleId: cycle.rows[0].id,
      originalItemIds,
      correctionId: correction.rows[0].id,
      decisionId: decisionRow.rows[0].id,
    };
  }

  it("creates a correction execution cycle, clones items as UNASSESSED, and copies no proof artifacts", async () => {
    const admin = await loginAs("admin");
    const viewer = await createUserInOrg(admin.orgId, "viewer");
    const ready = await seedReadyCorrection(admin.orgId, admin.userId);
    const notReady = await seedReadyCorrection(admin.orgId, admin.userId, "DRAFT");

    const viewerCreate = await request(app)
      .post(`/correction-resubmissions/${ready.correctionId}/execution-cycle`)
      .set("Authorization", `Bearer ${viewer.accessToken}`)
      .send();
    expect(viewerCreate.status).toBe(403);

    const notReadyCreate = await request(app)
      .post(`/correction-resubmissions/${notReady.correctionId}/execution-cycle`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send();
    expect(notReadyCreate.status).toBe(409);
    expect(notReadyCreate.body.code).toBe("CORRECTION_EXECUTION_REQUIRES_READY_CORRECTION");

    const created = await request(app)
      .post(`/correction-resubmissions/${ready.correctionId}/execution-cycle`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send();
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("CREATED");
    expect(created.body.originalAssessmentCycleId).toBe(ready.originalCycleId);

    const correctionCycle = await tx.query<{
      status: string;
      cycle_type: string;
      source_correction_resubmission_id: string;
      source_assessment_cycle_id: string;
    }>(
      `SELECT status, cycle_type, source_correction_resubmission_id, source_assessment_cycle_id FROM assessment_cycles WHERE id = $1`,
      [created.body.correctionAssessmentCycleId],
    );
    expect(correctionCycle.rows[0]).toMatchObject({
      status: "DRAFT",
      cycle_type: "CORRECTION",
      source_correction_resubmission_id: ready.correctionId,
      source_assessment_cycle_id: ready.originalCycleId,
    });

    const clonedItems = await tx.query<{
      pisf_requirement_id: string;
      requirement_key_snapshot: string;
      requirement_text_snapshot: string;
      source_hash_snapshot: string;
      assessment_status: string;
      updated_by_user_id: string | null;
    }>(
      `SELECT pisf_requirement_id, requirement_key_snapshot, requirement_text_snapshot, source_hash_snapshot, assessment_status, updated_by_user_id FROM assessment_requirement_items WHERE assessment_cycle_id = $1 ORDER BY requirement_key_snapshot`,
      [created.body.correctionAssessmentCycleId],
    );
    expect(clonedItems.rowCount).toBe(2);
    expect(clonedItems.rows.every((item) => item.assessment_status === "UNASSESSED")).toBe(true);
    expect(clonedItems.rows.every((item) => item.updated_by_user_id === null)).toBe(true);

    const originalItems = await tx.query<{ pisf_requirement_id: string; requirement_key_snapshot: string; requirement_text_snapshot: string; source_hash_snapshot: string }>(
      `SELECT pisf_requirement_id, requirement_key_snapshot, requirement_text_snapshot, source_hash_snapshot FROM assessment_requirement_items WHERE assessment_cycle_id = $1 ORDER BY requirement_key_snapshot`,
      [ready.originalCycleId],
    );
    expect(clonedItems.rows.map(({ pisf_requirement_id, requirement_key_snapshot, requirement_text_snapshot, source_hash_snapshot }) => ({ pisf_requirement_id, requirement_key_snapshot, requirement_text_snapshot, source_hash_snapshot }))).toEqual(originalItems.rows);

    const artifactCounts = await tx.query<{ evidence: string; checklists: string; scores: string; readiness: string; packages: string }>(
      `
      SELECT
        (SELECT count(*)::text FROM assessment_evidence_files WHERE assessment_cycle_id = $1) AS evidence,
        (SELECT count(*)::text FROM assessment_evidence_checklists WHERE assessment_cycle_id = $1) AS checklists,
        (SELECT count(*)::text FROM assessment_score_snapshots WHERE assessment_cycle_id = $1) AS scores,
        (SELECT count(*)::text FROM assessment_submission_readiness WHERE assessment_cycle_id = $1) AS readiness,
        (SELECT count(*)::text FROM assessment_submission_packages WHERE assessment_cycle_id = $1) AS packages
      `,
      [created.body.correctionAssessmentCycleId],
    );
    expect(artifactCounts.rows[0]).toEqual({ evidence: "0", checklists: "0", scores: "0", readiness: "0", packages: "0" });

    const duplicate = await request(app)
      .post(`/correction-resubmissions/${ready.correctionId}/execution-cycle`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send();
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe("CORRECTION_EXECUTION_CYCLE_ALREADY_EXISTS");

    const audit = await tx.query<{ event_type: string }>(
      `SELECT event_type FROM auth_audit_logs WHERE event_type = 'CORRECTION_EXECUTION_CYCLE_CREATED'`,
    );
    expect(audit.rowCount).toBe(1);
  });

  it("voids execution cycles, blocks invalid voids, supports recreate after void, and keeps reads unaudited", async () => {
    const admin = await loginAs("admin");
    const ready = await seedReadyCorrection(admin.orgId, admin.userId);
    const created = await request(app)
      .post(`/correction-resubmissions/${ready.correctionId}/execution-cycle`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send();
    expect(created.status).toBe(201);

    const invalidReason = await request(app)
      .post(`/correction-execution-cycles/${created.body.id}/void`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason: "short" });
    expect(invalidReason.status).toBe(400);
    expect(invalidReason.body.code).toBe("INVALID_CORRECTION_EXECUTION_VOID_REASON");

    const beforeReadAudits = await tx.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM auth_audit_logs`,
    );
    const read = await request(app)
      .get(`/correction-execution-cycles/${created.body.id}`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(read.status).toBe(200);
    const afterReadAudits = await tx.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM auth_audit_logs`,
    );
    expect(afterReadAudits.rows[0].count).toBe(beforeReadAudits.rows[0].count);

    const voided = await request(app)
      .post(`/correction-execution-cycles/${created.body.id}/void`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason: "Correction execution was created by mistake." });
    expect(voided.status).toBe(200);
    expect(voided.body.status).toBe("VOIDED");

    const secondVoid = await request(app)
      .post(`/correction-execution-cycles/${created.body.id}/void`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason: "Correction execution was created by mistake." });
    expect(secondVoid.status).toBe(409);
    expect(secondVoid.body.code).toBe("INVALID_CORRECTION_EXECUTION_STATUS");

    const activeRead = await request(app)
      .get(`/correction-resubmissions/${ready.correctionId}/execution-cycle`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(activeRead.status).toBe(404);

    const recreated = await request(app)
      .post(`/correction-resubmissions/${ready.correctionId}/execution-cycle`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send();
    expect(recreated.status).toBe(201);
    expect(recreated.body.id).not.toBe(created.body.id);

    const audit = await tx.query<{ event_type: string }>(
      `SELECT event_type FROM auth_audit_logs WHERE event_type = 'CORRECTION_EXECUTION_CYCLE_VOIDED'`,
    );
    expect(audit.rowCount).toBe(1);
  });

  it("blocks downstream mutation flows after a correction execution is voided", async () => {
    const admin = await loginAs("admin");
    const ready = await seedReadyCorrection(admin.orgId, admin.userId);
    const created = await request(app)
      .post(`/correction-resubmissions/${ready.correctionId}/execution-cycle`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send();
    expect(created.status).toBe(201);
    const correctionCycleId = String(created.body.correctionAssessmentCycleId);
    const item = await tx.query<{ id: string }>(
      `SELECT id FROM assessment_requirement_items WHERE assessment_cycle_id = $1 ORDER BY requirement_key_snapshot LIMIT 1`,
      [correctionCycleId],
    );
    const itemId = item.rows[0].id;
    const evidence = await tx.query<{ id: string }>(
      `INSERT INTO assessment_evidence_files (org_id, assessment_cycle_id, assessment_requirement_item_id, uploaded_by_user_id, original_filename, stored_filename, storage_key, storage_backend, mime_type_detected, file_extension, file_size_bytes, sha256_hash, validation_result_json, status) VALUES ($1, $2, $3, $4, 'correction.txt', 'stored.txt', $5, 'LOCAL', 'text/plain', '.txt', 12, $6, '{}'::jsonb, 'UPLOADED') RETURNING id`,
      [admin.orgId, correctionCycleId, itemId, admin.userId, `evidence/${randomUUID()}.txt`, "e".repeat(64)],
    );

    const voided = await request(app)
      .post(`/correction-execution-cycles/${created.body.id}/void`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason: "Correction execution was created by mistake." });
    expect(voided.status).toBe(200);

    const expectVoided = (response: request.Response) => {
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("CORRECTION_EXECUTION_VOIDED");
    };

    expectVoided(await request(app)
      .patch(`/assessments/cycles/${correctionCycleId}/items/${itemId}`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ assessmentStatus: "FULLY_COMPLIANT" }));

    expectVoided(await request(app)
      .post(`/assessments/cycles/${correctionCycleId}/items/${itemId}/evidence`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .attach("file", Buffer.from("evidence"), "evidence.txt"));

    expectVoided(await request(app)
      .post(`/evidence/${evidence.rows[0].id}/remove`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason: "Remove this correction evidence." }));

    expectVoided(await request(app)
      .put(`/assessments/cycles/${correctionCycleId}/items/${itemId}/evidence-checklist`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({
        datedWithin12Months: "YES",
        organizationSpecific: "YES",
        addressesRequirement: "YES",
        approvedByAuthority: "YES",
        currentlyInForce: "YES",
        evidenceQuality: "STRONG",
      }));

    expectVoided(await request(app)
      .post(`/assessments/cycles/${correctionCycleId}/finalize-internal`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send());

    await tx.query(
      `UPDATE assessment_cycles SET status = 'FINALIZED_INTERNAL', finalized_internal_by_user_id = $2, finalized_internal_at = now() WHERE id = $1`,
      [correctionCycleId, admin.userId],
    );

    expectVoided(await request(app)
      .post(`/assessments/cycles/${correctionCycleId}/calculate-score`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send());

    expectVoided(await request(app)
      .put(`/assessments/cycles/${correctionCycleId}/submission-readiness`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({
        confirmedAssessmentComplete: true,
        confirmedEvidenceAttached: true,
        confirmedEvidenceReviewed: true,
        confirmedScoreReviewed: true,
        confirmedAuthorizedSubmitter: true,
        confirmedInformationAccurate: true,
        declarationText: DECLARATION,
      }));

    await tx.query(
      `INSERT INTO assessment_submission_readiness (org_id, assessment_cycle_id, review_notes, confirmed_assessment_complete, confirmed_evidence_attached, confirmed_evidence_reviewed, confirmed_score_reviewed, confirmed_authorized_submitter, confirmed_information_accurate, declaration_text, declared_by_user_id) VALUES ($1, $2, 'Ready', TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, $3, $4) ON CONFLICT (assessment_cycle_id) DO NOTHING`,
      [admin.orgId, correctionCycleId, DECLARATION, admin.userId],
    );
    await tx.query(
      `INSERT INTO assessment_score_snapshots (assessment_cycle_id, org_id, overall_score, overall_label, total_requirements, applicable_requirements, not_applicable_requirements, fully_compliant_count, calculated_by_user_id, calculated_at) VALUES ($1, $2, 90, 'COMPLIANT', 1, 1, 0, 1, $3, now()) ON CONFLICT (assessment_cycle_id) DO NOTHING`,
      [correctionCycleId, admin.orgId, admin.userId],
    );

    expectVoided(await request(app)
      .post(`/assessments/cycles/${correctionCycleId}/mark-ready-for-submission`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send());

    await tx.query(`UPDATE assessment_cycles SET status = 'READY_FOR_SUBMISSION' WHERE id = $1`, [correctionCycleId]);

    expectVoided(await request(app)
      .post(`/assessments/cycles/${correctionCycleId}/submission-package`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send());
  });
});
