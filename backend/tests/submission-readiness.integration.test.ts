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
const HASH = "c".repeat(64);
const DECLARATION =
  "I confirm that the information provided in this assessment is accurate to the best of my knowledge and that the evidence has been reviewed internally.";

type LoginResult = {
  accessToken: string;
  userId: string;
  orgId: string;
};

type SeededCycle = {
  cycleId: string;
  itemId: string;
  requirementId: string;
  finalizedAt: Date;
};

describe("Submission readiness integration", () => {
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

  async function loginAs(
    role:
      | "admin"
      | "viewer"
      | "auditor"
      | "commenter"
      | "responsible_officer"
      | "it_security_lead",
  ): Promise<LoginResult> {
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
    role:
      | "admin"
      | "viewer"
      | "auditor"
      | "commenter"
      | "responsible_officer"
      | "it_security_lead",
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

  function readinessBody(overrides?: Record<string, unknown>) {
    return {
      confirmedAssessmentComplete: true,
      confirmedEvidenceAttached: true,
      confirmedEvidenceReviewed: true,
      confirmedScoreReviewed: true,
      confirmedAuthorizedSubmitter: true,
      confirmedInformationAccurate: true,
      declarationText: DECLARATION,
      reviewNotes: "Reviewed internally by compliance and IT teams.",
      ...overrides,
    };
  }

  async function seedFinalizedCycle(
    orgId: string,
    userId: string,
    options?: {
      status?: "FINALIZED_INTERNAL" | "READY_FOR_SUBMISSION";
      finalizedAt?: Date;
      scoreCalculatedAt?: Date | null;
      includeScore?: boolean;
    },
  ): Promise<SeededCycle> {
    const suffix = randomUUID();
    const finalizedAt = options?.finalizedAt ?? new Date("2026-04-25T10:00:00.000Z");
    const domain = await tx.query<{ id: string }>(
      `
      INSERT INTO pisf_domains (domain_code, name, source_hash)
      VALUES ($1, $2, $3)
      RETURNING id
      `,
      [`SR-${suffix}`, "Submission Readiness Domain", HASH],
    );
    const control = await tx.query<{ id: string }>(
      `
      INSERT INTO pisf_controls (
        domain_id,
        control_code,
        phase,
        area,
        sub_area,
        title,
        statement_text,
        source_statement_text,
        raw_source_json,
        source_hash
      )
      VALUES ($1, $2, 'phase', 'area', 'sub', 'Control', 'Statement', 'Statement', '{}'::jsonb, $3)
      RETURNING id
      `,
      [domain.rows[0].id, `SR-C-${suffix}`, HASH],
    );
    const requirement = await tx.query<{
      id: string;
      requirement_key: string;
      requirement_text: string;
      source_hash: string;
    }>(
      `
      INSERT INTO pisf_requirements (
        control_id,
        requirement_key,
        ordinal,
        requirement_text,
        source_control_text,
        derivation_method,
        status,
        source_hash
      )
      VALUES ($1, $2, 1, $3, $3, 'single_statement', 'ACTIVE', $4)
      RETURNING id, requirement_key, requirement_text, source_hash
      `,
      [control.rows[0].id, `SR-C-${suffix}::1`, "Requirement", HASH],
    );
    const cycle = await tx.query<{ id: string }>(
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
      [orgId, options?.status ?? "FINALIZED_INTERNAL", userId, finalizedAt],
    );
    const item = await tx.query<{ id: string }>(
      `
      INSERT INTO assessment_requirement_items (
        assessment_cycle_id,
        pisf_requirement_id,
        requirement_key_snapshot,
        requirement_text_snapshot,
        source_hash_snapshot,
        assessment_status,
        updated_by_user_id
      )
      VALUES ($1, $2, $3, $4, $5, 'FULLY_COMPLIANT', $6)
      RETURNING id
      `,
      [
        cycle.rows[0].id,
        requirement.rows[0].id,
        requirement.rows[0].requirement_key,
        requirement.rows[0].requirement_text,
        requirement.rows[0].source_hash,
        userId,
      ],
    );
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
        reviewed_by_user_id,
        reviewed_at
      )
      VALUES ($1, $2, $3, 'YES', 'YES', 'YES', 'YES', 'YES', 'STRONG', $4, $5)
      `,
      [orgId, cycle.rows[0].id, item.rows[0].id, userId, finalizedAt],
    );

    if (options?.includeScore ?? true) {
      await tx.query(
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
        `,
        [
          cycle.rows[0].id,
          orgId,
          userId,
          options?.scoreCalculatedAt === undefined
            ? finalizedAt
            : options.scoreCalculatedAt,
        ],
      );
    }

    return {
      cycleId: cycle.rows[0].id,
      itemId: item.rows[0].id,
      requirementId: requirement.rows[0].id,
      finalizedAt,
    };
  }

  async function putReadiness(
    accessToken: string,
    cycleId: string,
    body = readinessBody(),
  ) {
    return request(app)
      .put(`/assessments/cycles/${cycleId}/submission-readiness`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send(body);
  }

  async function markReady(accessToken: string, cycleId: string) {
    return request(app)
      .post(`/assessments/cycles/${cycleId}/mark-ready-for-submission`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({});
  }

  it("supports same-org read, missing 404, org isolation, and no read audit", async () => {
    const admin = await loginAs("admin");
    const viewer = await createUserInOrg(admin.orgId, "viewer");
    const otherAdmin = await loginAs("admin");
    const seeded = await seedFinalizedCycle(admin.orgId, admin.userId);

    const missing = await request(app)
      .get(`/assessments/cycles/${seeded.cycleId}/submission-readiness`)
      .set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("SUBMISSION_READINESS_NOT_FOUND");

    const created = await putReadiness(admin.accessToken, seeded.cycleId);
    expect(created.status).toBe(200);

    const beforeRead = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type = 'SUBMISSION_READINESS_UPSERTED'
      `,
    );

    const read = await request(app)
      .get(`/assessments/cycles/${seeded.cycleId}/submission-readiness`)
      .set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(read.status).toBe(200);
    expect(read.body.assessmentCycleId).toBe(seeded.cycleId);

    const afterRead = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type = 'SUBMISSION_READINESS_UPSERTED'
      `,
    );
    expect(afterRead.rows[0].count).toBe(beforeRead.rows[0].count);

    const crossOrgRead = await request(app)
      .get(`/assessments/cycles/${seeded.cycleId}/submission-readiness`)
      .set("Authorization", `Bearer ${otherAdmin.accessToken}`);
    expect(crossOrgRead.status).toBe(404);
  });

  it("enforces readiness PUT roles, cycle state, and validation", async () => {
    const admin = await loginAs("admin");
    const officer = await createUserInOrg(admin.orgId, "responsible_officer");
    const itLead = await createUserInOrg(admin.orgId, "it_security_lead");
    const auditor = await createUserInOrg(admin.orgId, "auditor");
    const viewer = await createUserInOrg(admin.orgId, "viewer");
    const commenter = await createUserInOrg(admin.orgId, "commenter");
    const seeded = await seedFinalizedCycle(admin.orgId, admin.userId);

    for (const allowed of [admin, officer, itLead]) {
      const response = await putReadiness(allowed.accessToken, seeded.cycleId);
      expect(response.status).toBe(200);
    }

    for (const denied of [auditor, viewer, commenter]) {
      const response = await putReadiness(denied.accessToken, seeded.cycleId);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("FORBIDDEN_ACTION");
    }

    const invalidBoolean = await putReadiness(
      admin.accessToken,
      seeded.cycleId,
      readinessBody({ confirmedScoreReviewed: "true" }),
    );
    expect(invalidBoolean.status).toBe(400);
    expect(invalidBoolean.body.code).toBe("INVALID_SUBMISSION_READINESS");

    const shortDeclaration = await putReadiness(
      admin.accessToken,
      seeded.cycleId,
      readinessBody({ declarationText: "too short" }),
    );
    expect(shortDeclaration.status).toBe(400);
    expect(shortDeclaration.body.code).toBe("INVALID_SUBMISSION_READINESS");

    const longNotes = await putReadiness(
      admin.accessToken,
      seeded.cycleId,
      readinessBody({ reviewNotes: "x".repeat(5001) }),
    );
    expect(longNotes.status).toBe(400);
    expect(longNotes.body.code).toBe("INVALID_SUBMISSION_READINESS");

    const draft = await tx.query<{ id: string }>(
      `
      INSERT INTO assessment_cycles (org_id, status, created_by_user_id)
      VALUES ($1, 'DRAFT', $2)
      RETURNING id
      `,
      [admin.orgId, admin.userId],
    );
    const draftPut = await putReadiness(admin.accessToken, draft.rows[0].id);
    expect(draftPut.status).toBe(409);
    expect(draftPut.body.code).toBe("SUBMISSION_READINESS_REQUIRES_FINALIZED_INTERNAL");
  });

  it("blocks mark-ready until readiness and fresh score exist, then succeeds", async () => {
    const admin = await loginAs("admin");
    const viewer = await createUserInOrg(admin.orgId, "viewer");
    const noReadiness = await seedFinalizedCycle(admin.orgId, admin.userId);

    const viewerMark = await markReady(viewer.accessToken, noReadiness.cycleId);
    expect(viewerMark.status).toBe(403);
    expect(viewerMark.body.code).toBe("FORBIDDEN_ACTION");

    const missingReadiness = await markReady(admin.accessToken, noReadiness.cycleId);
    expect(missingReadiness.status).toBe(404);
    expect(missingReadiness.body.code).toBe("SUBMISSION_READINESS_NOT_FOUND");

    const incomplete = await seedFinalizedCycle(admin.orgId, admin.userId);
    const incompletePut = await putReadiness(
      admin.accessToken,
      incomplete.cycleId,
      readinessBody({ confirmedEvidenceReviewed: false }),
    );
    expect(incompletePut.status).toBe(200);
    const incompleteMark = await markReady(admin.accessToken, incomplete.cycleId);
    expect(incompleteMark.status).toBe(409);
    expect(incompleteMark.body.code).toBe("SUBMISSION_READINESS_INCOMPLETE");

    const missingScore = await seedFinalizedCycle(admin.orgId, admin.userId, {
      includeScore: false,
    });
    await putReadiness(admin.accessToken, missingScore.cycleId);
    const noScore = await markReady(admin.accessToken, missingScore.cycleId);
    expect(noScore.status).toBe(409);
    expect(noScore.body.code).toBe("ASSESSMENT_SCORE_REQUIRED");

    const nullScore = await seedFinalizedCycle(admin.orgId, admin.userId, {
      scoreCalculatedAt: null,
    });
    await putReadiness(admin.accessToken, nullScore.cycleId);
    const nullScoreMark = await markReady(admin.accessToken, nullScore.cycleId);
    expect(nullScoreMark.status).toBe(409);
    expect(nullScoreMark.body.code).toBe("ASSESSMENT_SCORE_STALE");

    const stale = await seedFinalizedCycle(admin.orgId, admin.userId, {
      finalizedAt: new Date("2026-04-25T10:00:00.000Z"),
      scoreCalculatedAt: new Date("2026-04-25T09:59:59.999Z"),
    });
    await putReadiness(admin.accessToken, stale.cycleId);
    const staleMark = await markReady(admin.accessToken, stale.cycleId);
    expect(staleMark.status).toBe(409);
    expect(staleMark.body.code).toBe("ASSESSMENT_SCORE_STALE");

    const equal = await seedFinalizedCycle(admin.orgId, admin.userId, {
      finalizedAt: new Date("2026-04-25T10:00:00.000Z"),
      scoreCalculatedAt: new Date("2026-04-25T10:00:00.000Z"),
    });
    await putReadiness(admin.accessToken, equal.cycleId);
    const equalMark = await markReady(admin.accessToken, equal.cycleId);
    expect(equalMark.status).toBe(200);
    expect(equalMark.body.status).toBe("READY_FOR_SUBMISSION");

    const fresh = await seedFinalizedCycle(admin.orgId, admin.userId, {
      finalizedAt: new Date("2026-04-25T10:00:00.000Z"),
      scoreCalculatedAt: new Date("2026-04-25T10:00:00.001Z"),
    });
    await putReadiness(admin.accessToken, fresh.cycleId);
    const freshMark = await markReady(admin.accessToken, fresh.cycleId);
    expect(freshMark.status).toBe(200);
    expect(freshMark.body.status).toBe("READY_FOR_SUBMISSION");
  });

  it("locks readiness and existing mutations after READY_FOR_SUBMISSION", async () => {
    const admin = await loginAs("admin");
    const seeded = await seedFinalizedCycle(admin.orgId, admin.userId);
    await putReadiness(admin.accessToken, seeded.cycleId);
    const marked = await markReady(admin.accessToken, seeded.cycleId);
    expect(marked.status).toBe(200);

    const readinessUpdate = await putReadiness(admin.accessToken, seeded.cycleId);
    expect(readinessUpdate.status).toBe(409);
    expect(readinessUpdate.body.code).toBe("SUBMISSION_READINESS_LOCKED");

    const itemUpdate = await request(app)
      .patch(`/assessments/cycles/${seeded.cycleId}/items/${seeded.itemId}`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ assessmentStatus: "MOSTLY_COMPLIANT" });
    expect(itemUpdate.status).toBe(409);

    const evidenceUpload = await request(app)
      .post(`/assessments/cycles/${seeded.cycleId}/items/${seeded.itemId}/evidence`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .attach("file", Buffer.from("readiness lock evidence", "utf8"), {
        filename: "evidence.txt",
        contentType: "text/plain",
      });
    expect(evidenceUpload.status).toBe(409);

    const evidence = await tx.query<{ id: string }>(
      `
      INSERT INTO assessment_evidence_files (
        org_id,
        assessment_cycle_id,
        assessment_requirement_item_id,
        uploaded_by_user_id,
        original_filename,
        stored_filename,
        storage_key,
        storage_backend,
        mime_type_detected,
        file_extension,
        file_size_bytes,
        sha256_hash,
        validation_result_json,
        status
      )
      VALUES (
        $1, $2, $3, $4, 'evidence.txt', 'stored.txt', $5, 'LOCAL',
        'text/plain', 'txt', 12, $6, '{}'::jsonb, 'UPLOADED'
      )
      RETURNING id
      `,
      [
        admin.orgId,
        seeded.cycleId,
        seeded.itemId,
        admin.userId,
        `storage/${randomUUID()}`,
        HASH,
      ],
    );
    const evidenceRemove = await request(app)
      .post(`/evidence/${evidence.rows[0].id}/remove`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason: "Ready cycles cannot remove evidence." });
    expect(evidenceRemove.status).toBe(409);

    const checklistUpdate = await request(app)
      .put(`/assessments/cycles/${seeded.cycleId}/items/${seeded.itemId}/evidence-checklist`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({
        datedWithin12Months: "YES",
        organizationSpecific: "YES",
        addressesRequirement: "YES",
        approvedByAuthority: "YES",
        currentlyInForce: "YES",
        evidenceQuality: "STRONG",
      });
    expect(checklistUpdate.status).toBe(409);

    const scoreRecalc = await request(app)
      .post(`/assessments/cycles/${seeded.cycleId}/calculate-score`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({});
    expect(scoreRecalc.status).toBe(409);
  });

  it("audits readiness upsert and mark-ready but not reads", async () => {
    const admin = await loginAs("admin");
    const seeded = await seedFinalizedCycle(admin.orgId, admin.userId);

    const put = await putReadiness(admin.accessToken, seeded.cycleId);
    expect(put.status).toBe(200);
    const read = await request(app)
      .get(`/assessments/cycles/${seeded.cycleId}/submission-readiness`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(read.status).toBe(200);
    const marked = await markReady(admin.accessToken, seeded.cycleId);
    expect(marked.status).toBe(200);

    const audit = await tx.query<{ event_type: string; count: string }>(
      `
      SELECT event_type, count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type IN (
        'SUBMISSION_READINESS_UPSERTED',
        'ASSESSMENT_MARKED_READY_FOR_SUBMISSION'
      )
      GROUP BY event_type
      `,
    );
    const map = new Map(audit.rows.map((row) => [row.event_type, Number(row.count)]));
    expect(map.get("SUBMISSION_READINESS_UPSERTED")).toBe(1);
    expect(map.get("ASSESSMENT_MARKED_READY_FOR_SUBMISSION")).toBe(1);

    const markReadyAudit = await tx.query<{ metadata: Record<string, unknown> }>(
      `
      SELECT metadata
      FROM auth_audit_logs
      WHERE event_type = 'ASSESSMENT_MARKED_READY_FOR_SUBMISSION'
      ORDER BY created_at DESC
      LIMIT 1
      `,
    );
    expect(markReadyAudit.rows[0].metadata).toMatchObject({
      org_id: admin.orgId,
      assessment_cycle_id: seeded.cycleId,
      previous_status: "FINALIZED_INTERNAL",
      new_status: "READY_FOR_SUBMISSION",
      overall_label: "COMPLIANT",
      actor_user_id: admin.userId,
      actor_org_id: admin.orgId,
    });
  });
});
