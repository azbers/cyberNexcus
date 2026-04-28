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

type SeededReadyCycle = {
  cycleId: string;
  itemId: string;
  readinessId: string | null;
  scoreSnapshotId: string | null;
  finalizedAt: Date;
};

describe("Submission package integration", () => {
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

  async function seedCycle(
    orgId: string,
    userId: string,
    options?: {
      cycleStatus?: "DRAFT" | "FINALIZED_INTERNAL" | "READY_FOR_SUBMISSION";
      includeReadiness?: boolean;
      includeScore?: boolean;
      scoreCalculatedAt?: Date | null;
      finalizedAt?: Date;
    },
  ): Promise<SeededReadyCycle> {
    const suffix = randomUUID();
    const finalizedAt = options?.finalizedAt ?? new Date("2026-04-25T10:00:00.000Z");
    const status = options?.cycleStatus ?? "READY_FOR_SUBMISSION";

    const domain = await tx.query<{ id: string }>(
      `
      INSERT INTO pisf_domains (domain_code, name, source_hash)
      VALUES ($1, $2, $3)
      RETURNING id
      `,
      [`SP-${suffix}`, "Submission Package Domain", HASH],
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
      [domain.rows[0].id, `SP-C-${suffix}`, HASH],
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
      [control.rows[0].id, `SP-C-${suffix}::1`, "Requirement", HASH],
    );

    const cycle =
      status === "DRAFT"
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
            [orgId, status, userId, finalizedAt],
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

    await tx.query(
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
      `,
      [orgId, cycle.rows[0].id, item.rows[0].id, userId, `storage/${suffix}`, HASH],
    );

    let readinessId: string | null = null;
    if (options?.includeReadiness ?? true) {
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
        VALUES ($1, $2, 'Ready for package.', TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, $3, $4, $5)
        RETURNING id
        `,
        [orgId, cycle.rows[0].id, DECLARATION, userId, finalizedAt],
      );
      readinessId = readiness.rows[0].id;
    }

    let scoreSnapshotId: string | null = null;
    if (options?.includeScore ?? true) {
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
        [
          cycle.rows[0].id,
          orgId,
          userId,
          options?.scoreCalculatedAt === undefined
            ? finalizedAt
            : options.scoreCalculatedAt,
        ],
      );
      scoreSnapshotId = score.rows[0].id;
    }

    return {
      cycleId: cycle.rows[0].id,
      itemId: item.rows[0].id,
      readinessId,
      scoreSnapshotId,
      finalizedAt,
    };
  }

  async function createPackage(accessToken: string, cycleId: string) {
    return request(app)
      .post(`/assessments/cycles/${cycleId}/submission-package`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({});
  }

  async function voidPackage(accessToken: string, packageId: string, reason: unknown) {
    return request(app)
      .post(`/submission-packages/${packageId}/void`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ reason });
  }

  it("creates package for valid ready cycle and stores canonical manifest hash", async () => {
    const admin = await loginAs("admin");
    const viewer = await createUserInOrg(admin.orgId, "viewer");
    const seeded = await seedCycle(admin.orgId, admin.userId);

    const created = await createPackage(admin.accessToken, seeded.cycleId);
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("CREATED");
    expect(created.body.packageNumber).toMatch(/^SUB-\d{8}-[0-9A-F]{8}$/);
    expect(created.body.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.body.manifestHash).toBe(
      manifestHashFor(created.body.manifestJson),
    );
    expect(created.body.manifestJson).toMatchObject({
      packageVersion: "SUBMISSION_PACKAGE_V1",
      orgId: admin.orgId,
      assessmentCycleId: seeded.cycleId,
      scoreSnapshotId: seeded.scoreSnapshotId,
      readinessId: seeded.readinessId,
      createdByUserId: admin.userId,
      assessmentStatus: "READY_FOR_SUBMISSION",
      scoringVersion: "SCORING_V1",
      overallScore: 100,
      overallLabel: "COMPLIANT",
      counts: {
        totalRequirements: 1,
        applicableRequirements: 1,
        notApplicableRequirements: 0,
        evidenceFiles: 1,
        checklists: 1,
      },
      hashes: {
        manifestHashAlgorithm: "SHA-256",
      },
    });

    const readByCycle = await request(app)
      .get(`/assessments/cycles/${seeded.cycleId}/submission-package`)
      .set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(readByCycle.status).toBe(200);
    expect(readByCycle.body.id).toBe(created.body.id);

    const readById = await request(app)
      .get(`/submission-packages/${created.body.id}`)
      .set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(readById.status).toBe(200);
    expect(readById.body.id).toBe(created.body.id);
  });

  it("enforces create authorization and prerequisite guards", async () => {
    const admin = await loginAs("admin");
    const viewer = await createUserInOrg(admin.orgId, "viewer");

    const valid = await seedCycle(admin.orgId, admin.userId);
    const viewerCreate = await createPackage(viewer.accessToken, valid.cycleId);
    expect(viewerCreate.status).toBe(403);
    expect(viewerCreate.body.code).toBe("FORBIDDEN_ACTION");

    const finalized = await seedCycle(admin.orgId, admin.userId, {
      cycleStatus: "FINALIZED_INTERNAL",
    });
    const wrongState = await createPackage(admin.accessToken, finalized.cycleId);
    expect(wrongState.status).toBe(409);
    expect(wrongState.body.code).toBe("SUBMISSION_PACKAGE_REQUIRES_READY_FOR_SUBMISSION");

    const noReadiness = await seedCycle(admin.orgId, admin.userId, {
      includeReadiness: false,
    });
    const missingReadiness = await createPackage(admin.accessToken, noReadiness.cycleId);
    expect(missingReadiness.status).toBe(404);
    expect(missingReadiness.body.code).toBe("SUBMISSION_READINESS_NOT_FOUND");

    const noScore = await seedCycle(admin.orgId, admin.userId, {
      includeScore: false,
    });
    const missingScore = await createPackage(admin.accessToken, noScore.cycleId);
    expect(missingScore.status).toBe(409);
    expect(missingScore.body.code).toBe("ASSESSMENT_SCORE_REQUIRED");

    const nullScore = await seedCycle(admin.orgId, admin.userId, {
      scoreCalculatedAt: null,
    });
    const nullScoreCreate = await createPackage(admin.accessToken, nullScore.cycleId);
    expect(nullScoreCreate.status).toBe(409);
    expect(nullScoreCreate.body.code).toBe("ASSESSMENT_SCORE_STALE");

    const stale = await seedCycle(admin.orgId, admin.userId, {
      finalizedAt: new Date("2026-04-25T10:00:00.000Z"),
      scoreCalculatedAt: new Date("2026-04-25T09:59:59.999Z"),
    });
    const staleCreate = await createPackage(admin.accessToken, stale.cycleId);
    expect(staleCreate.status).toBe(409);
    expect(staleCreate.body.code).toBe("ASSESSMENT_SCORE_STALE");
  });

  it("blocks second active package, supports void-and-recreate, and keeps voided packages readable by id", async () => {
    const admin = await loginAs("admin");
    const seeded = await seedCycle(admin.orgId, admin.userId);
    const first = await createPackage(admin.accessToken, seeded.cycleId);
    expect(first.status).toBe(201);

    const duplicate = await createPackage(admin.accessToken, seeded.cycleId);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe("SUBMISSION_PACKAGE_ALREADY_EXISTS");

    const voided = await voidPackage(
      admin.accessToken,
      first.body.id,
      "Package was created before final internal legal review was completed.",
    );
    expect(voided.status).toBe(200);
    expect(voided.body.status).toBe("VOIDED");
    expect(voided.body.voidedByUserId).toBe(admin.userId);
    expect(voided.body.voidReason).toBe(
      "Package was created before final internal legal review was completed.",
    );
    expect(voided.body.manifestHash).toBe(first.body.manifestHash);
    expect(voided.body.manifestJson).toEqual(first.body.manifestJson);

    const activeAfterVoid = await request(app)
      .get(`/assessments/cycles/${seeded.cycleId}/submission-package`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(activeAfterVoid.status).toBe(404);
    expect(activeAfterVoid.body.code).toBe("SUBMISSION_PACKAGE_NOT_FOUND");

    const readVoided = await request(app)
      .get(`/submission-packages/${first.body.id}`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(readVoided.status).toBe(200);
    expect(readVoided.body.status).toBe("VOIDED");

    const replacement = await createPackage(admin.accessToken, seeded.cycleId);
    expect(replacement.status).toBe(201);
    expect(replacement.body.id).not.toBe(first.body.id);
  });

  it("enforces void authorization, reason validation, and prevents double void", async () => {
    const admin = await loginAs("admin");
    const viewer = await createUserInOrg(admin.orgId, "viewer");
    const seeded = await seedCycle(admin.orgId, admin.userId);
    const created = await createPackage(admin.accessToken, seeded.cycleId);
    expect(created.status).toBe(201);

    const viewerVoid = await voidPackage(
      viewer.accessToken,
      created.body.id,
      "Viewer should not be able to void this package.",
    );
    expect(viewerVoid.status).toBe(403);
    expect(viewerVoid.body.code).toBe("FORBIDDEN_ACTION");

    const shortReason = await voidPackage(admin.accessToken, created.body.id, "short");
    expect(shortReason.status).toBe(400);
    expect(shortReason.body.code).toBe("INVALID_SUBMISSION_PACKAGE_VOID_REASON");

    const voided = await voidPackage(
      admin.accessToken,
      created.body.id,
      "Voiding package for integration test coverage.",
    );
    expect(voided.status).toBe(200);

    const secondVoid = await voidPackage(
      admin.accessToken,
      created.body.id,
      "Second void should be rejected by status guard.",
    );
    expect(secondVoid.status).toBe(409);
  });

  it("blocks cross-org read/create/void and does not audit reads", async () => {
    const admin = await loginAs("admin");
    const otherAdmin = await loginAs("admin");
    const seeded = await seedCycle(admin.orgId, admin.userId);
    const created = await createPackage(admin.accessToken, seeded.cycleId);
    expect(created.status).toBe(201);

    const beforeRead = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type IN ('SUBMISSION_PACKAGE_CREATED', 'SUBMISSION_PACKAGE_VOIDED')
      `,
    );

    const sameOrgRead = await request(app)
      .get(`/submission-packages/${created.body.id}`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(sameOrgRead.status).toBe(200);

    const afterRead = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type IN ('SUBMISSION_PACKAGE_CREATED', 'SUBMISSION_PACKAGE_VOIDED')
      `,
    );
    expect(afterRead.rows[0].count).toBe(beforeRead.rows[0].count);

    const crossOrgRead = await request(app)
      .get(`/submission-packages/${created.body.id}`)
      .set("Authorization", `Bearer ${otherAdmin.accessToken}`);
    expect(crossOrgRead.status).toBe(404);

    const crossOrgCycleRead = await request(app)
      .get(`/assessments/cycles/${seeded.cycleId}/submission-package`)
      .set("Authorization", `Bearer ${otherAdmin.accessToken}`);
    expect(crossOrgCycleRead.status).toBe(404);

    const crossOrgCreate = await createPackage(otherAdmin.accessToken, seeded.cycleId);
    expect(crossOrgCreate.status).toBe(404);

    const crossOrgVoid = await voidPackage(
      otherAdmin.accessToken,
      created.body.id,
      "Cross org should not void package.",
    );
    expect(crossOrgVoid.status).toBe(404);
  });

  it("prevents direct DB changes to immutable manifest and identity fields", async () => {
    const admin = await loginAs("admin");
    const seeded = await seedCycle(admin.orgId, admin.userId);
    const created = await createPackage(admin.accessToken, seeded.cycleId);
    expect(created.status).toBe(201);

    await tx.query("SAVEPOINT immutable_manifest_json");
    await expect(
      tx.query(
        `
        UPDATE assessment_submission_packages
        SET manifest_json = jsonb_set(manifest_json, '{tampered}', 'true'::jsonb)
        WHERE id = $1
        `,
        [created.body.id],
      ),
    ).rejects.toThrow();
    await tx.query("ROLLBACK TO SAVEPOINT immutable_manifest_json");

    await tx.query("SAVEPOINT immutable_manifest_hash");
    await expect(
      tx.query(
        `
        UPDATE assessment_submission_packages
        SET manifest_hash = $2
        WHERE id = $1
        `,
        [created.body.id, "e".repeat(64)],
      ),
    ).rejects.toThrow();
    await tx.query("ROLLBACK TO SAVEPOINT immutable_manifest_hash");

    await tx.query("SAVEPOINT immutable_package_number");
    await expect(
      tx.query(
        `
        UPDATE assessment_submission_packages
        SET package_number = 'SUB-20260425-FFFFFFFF'
        WHERE id = $1
        `,
        [created.body.id],
      ),
    ).rejects.toThrow();
    await tx.query("ROLLBACK TO SAVEPOINT immutable_package_number");
  });

  it("creates audit rows for create and void with expected metadata", async () => {
    const admin = await loginAs("admin");
    const seeded = await seedCycle(admin.orgId, admin.userId);
    const created = await createPackage(admin.accessToken, seeded.cycleId);
    expect(created.status).toBe(201);

    const voided = await voidPackage(
      admin.accessToken,
      created.body.id,
      "Voiding package to inspect audit metadata.",
    );
    expect(voided.status).toBe(200);

    const audit = await tx.query<{ event_type: string; metadata: Record<string, unknown> }>(
      `
      SELECT event_type, metadata
      FROM auth_audit_logs
      WHERE event_type IN ('SUBMISSION_PACKAGE_CREATED', 'SUBMISSION_PACKAGE_VOIDED')
      ORDER BY created_at ASC
      `,
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      "SUBMISSION_PACKAGE_CREATED",
      "SUBMISSION_PACKAGE_VOIDED",
    ]);
    expect(audit.rows[0].metadata).toMatchObject({
      org_id: admin.orgId,
      assessment_cycle_id: seeded.cycleId,
      submission_package_id: created.body.id,
      package_number: created.body.packageNumber,
      manifest_hash: created.body.manifestHash,
      score_snapshot_id: seeded.scoreSnapshotId,
      actor_user_id: admin.userId,
      actor_org_id: admin.orgId,
    });
    expect(audit.rows[1].metadata).toMatchObject({
      org_id: admin.orgId,
      assessment_cycle_id: seeded.cycleId,
      submission_package_id: created.body.id,
      package_number: created.body.packageNumber,
      reason: "Voiding package to inspect audit metadata.",
      actor_user_id: admin.userId,
      actor_org_id: admin.orgId,
    });
  });
});
