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
const HASH = "a".repeat(64);

type LoginResult = {
  accessToken: string;
  userId: string;
  orgId: string;
};

type SeededScoringCycle = {
  cycleId: string;
  controlAId: string;
  controlBId: string;
  itemIds: string[];
};

describe("Scoring integration", () => {
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

  async function createUserInOrg(orgId: string, role: "admin" | "viewer"): Promise<LoginResult> {
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

  async function seedFinalizedScoringCycle(
    orgId: string,
    userId: string,
    options?: { includeChecklist?: boolean; statusOverride?: string },
  ): Promise<SeededScoringCycle> {
    const suffix = randomUUID();
    const domain = await tx.query<{ id: string }>(
      `
      INSERT INTO pisf_domains (domain_code, name, source_hash)
      VALUES ($1, $2, $3)
      RETURNING id
      `,
      [`SCORING-${suffix}`, "Scoring Domain", HASH],
    );
    const controlA = await tx.query<{ id: string }>(
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
      VALUES ($1, $2, 'phase', 'area', 'sub', 'Control A', 'Statement A', 'Statement A', '{}'::jsonb, $3)
      RETURNING id
      `,
      [domain.rows[0].id, `SC-A-${suffix}`, HASH],
    );
    const controlB = await tx.query<{ id: string }>(
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
      VALUES ($1, $2, 'phase', 'area', 'sub', 'Control B', 'Statement B', 'Statement B', '{}'::jsonb, $3)
      RETURNING id
      `,
      [domain.rows[0].id, `SC-B-${suffix}`, HASH],
    );

    const requirementInputs = [
      { controlId: controlA.rows[0].id, ordinal: 1, key: `SC-A-${suffix}::1`, status: "FULLY_COMPLIANT", quality: "MODERATE" },
      { controlId: controlA.rows[0].id, ordinal: 2, key: `SC-A-${suffix}::2`, status: "MOSTLY_COMPLIANT", quality: "WEAK" },
      { controlId: controlB.rows[0].id, ordinal: 1, key: `SC-B-${suffix}::1`, status: "PARTIALLY_COMPLIANT", quality: "NONE" },
      { controlId: controlB.rows[0].id, ordinal: 2, key: `SC-B-${suffix}::2`, status: "NOT_COMPLIANT", quality: "STRONG" },
      { controlId: controlB.rows[0].id, ordinal: 3, key: `SC-B-${suffix}::3`, status: "NOT_APPLICABLE", quality: null },
    ];

    const requirements: Array<{ id: string; requirement_key: string; requirement_text: string; source_hash: string; status: string; quality: string | null }> = [];
    for (const input of requirementInputs) {
      const requirement = await tx.query<{ id: string; requirement_key: string; requirement_text: string; source_hash: string }>(
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
        VALUES ($1, $2, $3, $4, $4, 'single_statement', 'ACTIVE', $5)
        RETURNING id, requirement_key, requirement_text, source_hash
        `,
        [input.controlId, input.key, input.ordinal, `Requirement ${input.key}`, HASH],
      );
      requirements.push({
        ...requirement.rows[0],
        status: options?.statusOverride ?? input.status,
        quality: input.quality,
      });
    }

    const cycle = await tx.query<{ id: string }>(
      `
      INSERT INTO assessment_cycles (
        org_id,
        status,
        created_by_user_id,
        finalized_internal_by_user_id,
        finalized_internal_at
      )
      VALUES ($1, 'FINALIZED_INTERNAL', $2, $2, now())
      RETURNING id
      `,
      [orgId, userId],
    );

    const itemIds: string[] = [];
    for (const requirement of requirements) {
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
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
        `,
        [
          cycle.rows[0].id,
          requirement.id,
          requirement.requirement_key,
          requirement.requirement_text,
          requirement.source_hash,
          requirement.status,
          userId,
        ],
      );
      itemIds.push(item.rows[0].id);

      if ((options?.includeChecklist ?? true) && requirement.status !== "NOT_APPLICABLE") {
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
          VALUES ($1, $2, $3, 'YES', 'YES', 'YES', 'YES', 'YES', $4, NULL, $5, now())
          `,
          [orgId, cycle.rows[0].id, item.rows[0].id, requirement.quality ?? "STRONG", userId],
        );
      }
    }

    return {
      cycleId: cycle.rows[0].id,
      controlAId: controlA.rows[0].id,
      controlBId: controlB.rows[0].id,
      itemIds,
    };
  }

  it("calculates requirement, control, and assessment scores deterministically", async () => {
    const admin = await loginAs("admin");
    const viewer = await createUserInOrg(admin.orgId, "viewer");
    const seeded = await seedFinalizedScoringCycle(admin.orgId, admin.userId);

    const calculated = await request(app)
      .post(`/assessments/cycles/${seeded.cycleId}/calculate-score`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({});
    expect(calculated.status).toBe(200);
    expect(calculated.body.overallScore).toBe("37.50");
    expect(calculated.body.overallLabel).toBe("NON_COMPLIANT");
    expect(calculated.body.applicableRequirements).toBe(4);
    expect(calculated.body.notApplicableRequirements).toBe(1);

    const requirements = await request(app)
      .get(`/assessments/cycles/${seeded.cycleId}/score/requirements?page=1&pageSize=10`)
      .set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(requirements.status).toBe(200);
    const finalScores = requirements.body.items.map((item: { finalScore: string | null }) => item.finalScore);
    expect(finalScores).toEqual(expect.arrayContaining(["80.00", "50.00", "20.00", "0.00", null]));
    const excluded = requirements.body.items.find(
      (item: { excluded: boolean }) => item.excluded,
    );
    expect(excluded).toEqual(expect.objectContaining({ exclusionReason: "NOT_APPLICABLE" }));

    const controls = await request(app)
      .get(`/assessments/cycles/${seeded.cycleId}/score/controls?page=1&pageSize=10`)
      .set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(controls.status).toBe(200);
    expect(controls.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pisfControlId: seeded.controlAId, controlScore: "65.00" }),
        expect.objectContaining({ pisfControlId: seeded.controlBId, controlScore: "10.00" }),
      ]),
    );
  });

  it("enforces calculate/read authorization and cycle state guards", async () => {
    const admin = await loginAs("admin");
    const viewer = await createUserInOrg(admin.orgId, "viewer");
    const otherAdmin = await loginAs("admin");
    const seeded = await seedFinalizedScoringCycle(admin.orgId, admin.userId);

    const viewerCalculate = await request(app)
      .post(`/assessments/cycles/${seeded.cycleId}/calculate-score`)
      .set("Authorization", `Bearer ${viewer.accessToken}`)
      .send({});
    expect(viewerCalculate.status).toBe(403);
    expect(viewerCalculate.body.code).toBe("FORBIDDEN_ACTION");

    const crossOrgRead = await request(app)
      .get(`/assessments/cycles/${seeded.cycleId}/score`)
      .set("Authorization", `Bearer ${otherAdmin.accessToken}`);
    expect(crossOrgRead.status).toBe(404);

    const draft = await tx.query<{ id: string }>(
      `
      INSERT INTO assessment_cycles (org_id, status, created_by_user_id)
      VALUES ($1, 'DRAFT', $2)
      RETURNING id
      `,
      [admin.orgId, admin.userId],
    );
    const draftCalculate = await request(app)
      .post(`/assessments/cycles/${draft.rows[0].id}/calculate-score`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({});
    expect(draftCalculate.status).toBe(409);
    expect(draftCalculate.body.code).toBe("ASSESSMENT_SCORE_REQUIRES_FINALIZED_INTERNAL");
  });

  it("blocks scoring for unassessed items and missing required checklists", async () => {
    const admin = await loginAs("admin");
    const unassessed = await seedFinalizedScoringCycle(admin.orgId, admin.userId, {
      statusOverride: "UNASSESSED",
    });

    const blockedUnassessed = await request(app)
      .post(`/assessments/cycles/${unassessed.cycleId}/calculate-score`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({});
    expect(blockedUnassessed.status).toBe(409);
    expect(blockedUnassessed.body.code).toBe("ASSESSMENT_SCORE_BLOCKED_UNASSESSED");

    const missingChecklist = await seedFinalizedScoringCycle(admin.orgId, admin.userId, {
      includeChecklist: false,
    });
    const blockedChecklist = await request(app)
      .post(`/assessments/cycles/${missingChecklist.cycleId}/calculate-score`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({});
    expect(blockedChecklist.status).toBe(409);
    expect(blockedChecklist.body.code).toBe("ASSESSMENT_SCORE_BLOCKED_MISSING_EVIDENCE_CHECKLIST");
  });

  it("keeps one current snapshot and removes stale detail rows on recalculation", async () => {
    const admin = await loginAs("admin");
    const seeded = await seedFinalizedScoringCycle(admin.orgId, admin.userId);

    const first = await request(app)
      .post(`/assessments/cycles/${seeded.cycleId}/calculate-score`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({});
    expect(first.status).toBe(200);
    const snapshotId = String(first.body.id);

    const staleCycle = await tx.query<{ id: string }>(
      `
      INSERT INTO assessment_cycles (
        org_id,
        status,
        created_by_user_id,
        finalized_internal_by_user_id,
        finalized_internal_at
      )
      VALUES ($1, 'FINALIZED_INTERNAL', $2, $2, now())
      RETURNING id
      `,
      [admin.orgId, admin.userId],
    );
    const sourceItem = await tx.query<{
      pisf_requirement_id: string;
      requirement_key_snapshot: string;
      requirement_text_snapshot: string;
      source_hash_snapshot: string;
    }>(
      `
      SELECT
        pisf_requirement_id,
        requirement_key_snapshot,
        requirement_text_snapshot,
        source_hash_snapshot
      FROM assessment_requirement_items
      WHERE id = $1
      `,
      [seeded.itemIds[0]],
    );
    const staleItem = await tx.query<{ id: string }>(
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
        staleCycle.rows[0].id,
        sourceItem.rows[0].pisf_requirement_id,
        `${sourceItem.rows[0].requirement_key_snapshot}-STALE`,
        sourceItem.rows[0].requirement_text_snapshot,
        sourceItem.rows[0].source_hash_snapshot,
        admin.userId,
      ],
    );
    await tx.query(
      `
      INSERT INTO assessment_requirement_scores (
        score_snapshot_id,
        assessment_requirement_item_id,
        pisf_requirement_id,
        assessment_status,
        evidence_quality,
        status_score,
        evidence_quality_cap,
        final_score,
        excluded,
        exclusion_reason
      )
      VALUES ($1, $2, $3, 'FULLY_COMPLIANT', 'STRONG', 100, 100, 100, FALSE, NULL)
      `,
      [snapshotId, staleItem.rows[0].id, sourceItem.rows[0].pisf_requirement_id],
    );

    const second = await request(app)
      .post(`/assessments/cycles/${seeded.cycleId}/calculate-score`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({});
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(snapshotId);

    const snapshots = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM assessment_score_snapshots
      WHERE assessment_cycle_id = $1
      `,
      [seeded.cycleId],
    );
    expect(snapshots.rows[0].count).toBe("1");

    const staleRows = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM assessment_requirement_scores
      WHERE score_snapshot_id = $1
        AND assessment_requirement_item_id = $2
      `,
      [snapshotId, staleItem.rows[0].id],
    );
    expect(staleRows.rows[0].count).toBe("0");
  });

  it("supports zero applicable requirements with null score and no read audit", async () => {
    const admin = await loginAs("admin");
    const viewer = await createUserInOrg(admin.orgId, "viewer");
    const seeded = await seedFinalizedScoringCycle(admin.orgId, admin.userId, {
      statusOverride: "NOT_APPLICABLE",
      includeChecklist: false,
    });

    const calculated = await request(app)
      .post(`/assessments/cycles/${seeded.cycleId}/calculate-score`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({});
    expect(calculated.status).toBe(200);
    expect(calculated.body.overallScore).toBeNull();
    expect(calculated.body.overallLabel).toBeNull();
    expect(calculated.body.applicableRequirements).toBe(0);

    const auditBefore = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type = 'ASSESSMENT_SCORE_CALCULATED'
      `,
    );

    const read = await request(app)
      .get(`/assessments/cycles/${seeded.cycleId}/score`)
      .set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(read.status).toBe(200);
    expect(read.body.overallScore).toBeNull();

    const auditAfter = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type = 'ASSESSMENT_SCORE_CALCULATED'
      `,
    );
    expect(auditAfter.rows[0].count).toBe(auditBefore.rows[0].count);
  });
});
