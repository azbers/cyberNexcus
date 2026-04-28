import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import { createPool } from "../src/db/pool.js";
import {
  beginIsolatedTestTransaction,
  DEFAULT_TEST_DATABASE_URL,
  rollbackAndRelease,
} from "./test-db.js";

describe("correction resubmission migrations", () => {
  let pool: Pool;
  let tx: PoolClient;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL);
  });

  beforeEach(async () => {
    tx = await beginIsolatedTestTransaction(pool);
  });

  afterEach(async () => {
    await rollbackAndRelease(tx);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates correction table constraints, indexes, triggers, and FK restrictions", async () => {
    const table = await tx.query<{ name: string }>(
      `SELECT to_regclass('public.correction_resubmissions')::text AS name`,
    );
    expect(table.rows[0].name).toBe("correction_resubmissions");

    const constraints = await tx.query<{
      conname: string;
      definition: string;
      confdeltype: string;
    }>(
      `
      SELECT conname, pg_get_constraintdef(oid) AS definition, confdeltype
      FROM pg_constraint
      WHERE conrelid = 'correction_resubmissions'::regclass
      ORDER BY conname
      `,
    );
    const definitions = constraints.rows.map((row) => row.definition).join("\n");
    expect(definitions).toContain("DRAFT");
    expect(definitions).toContain("READY_FOR_RESUBMISSION");
    expect(definitions).toContain("VOIDED");
    expect(definitions).toContain("length(btrim(correction_reason)) >= 20");
    expect(definitions).toContain("length(btrim(correction_reason)) <= 5000");
    expect(definitions).toContain("length(correction_summary) <= 5000");
    expect(definitions).toContain("length(btrim(void_reason)) >= 10");
    expect(definitions).toContain("length(btrim(void_reason)) <= 2000");
    expect(
      constraints.rows
        .filter((row) => row.definition.startsWith("FOREIGN KEY"))
        .every((row) => row.confdeltype === "r"),
    ).toBe(true);

    const indexes = await tx.query<{ indexname: string; indexdef: string }>(
      `
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'correction_resubmissions'
      ORDER BY indexname
      `,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "idx_correction_resubmissions_org",
        "idx_correction_resubmissions_original_external_submission",
        "idx_correction_resubmissions_original_decision",
        "idx_correction_resubmissions_status",
        "idx_correction_resubmissions_created_at",
        "uq_one_active_correction_per_decision",
      ]),
    );
    expect(
      indexes.rows.find((row) => row.indexname === "uq_one_active_correction_per_decision")?.indexdef,
    ).toContain("WHERE (status = ANY (ARRAY['DRAFT'::text, 'READY_FOR_RESUBMISSION'::text]))");

    const triggers = await tx.query<{ tgname: string }>(
      `
      SELECT tgname
      FROM pg_trigger
      WHERE tgrelid = 'correction_resubmissions'::regclass
        AND NOT tgisinternal
      `,
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual(
      expect.arrayContaining([
        "correction_resubmissions_immutable_identity",
        "correction_resubmissions_00_set_updated_at",
      ]),
    );
  });

  it("prevents direct DB changes to immutable correction identity fields", async () => {
    const seeded = await seedReturnedDecision();
    const correction = await tx.query<{ id: string }>(
      `
      INSERT INTO correction_resubmissions (
        org_id,
        original_external_submission_id,
        original_decision_id,
        original_submission_package_id,
        original_assessment_cycle_id,
        status,
        correction_reason,
        created_by_user_id
      )
      VALUES ($1, $2, $3, $4, $5, 'DRAFT', $6, $7)
      RETURNING id
      `,
      [
        seeded.orgId,
        seeded.externalSubmissionId,
        seeded.decisionId,
        seeded.packageId,
        seeded.assessmentCycleId,
        "PKCERT returned the submission for correction because evidence was insufficient.",
        seeded.userId,
      ],
    );

    const immutableUpdates = [
      ["org_id", "UPDATE correction_resubmissions SET org_id = $2 WHERE id = $1", randomUUID()],
      ["original_external_submission_id", "UPDATE correction_resubmissions SET original_external_submission_id = $2 WHERE id = $1", randomUUID()],
      ["original_decision_id", "UPDATE correction_resubmissions SET original_decision_id = $2 WHERE id = $1", randomUUID()],
      ["original_submission_package_id", "UPDATE correction_resubmissions SET original_submission_package_id = $2 WHERE id = $1", randomUUID()],
      ["original_assessment_cycle_id", "UPDATE correction_resubmissions SET original_assessment_cycle_id = $2 WHERE id = $1", randomUUID()],
      ["created_by_user_id", "UPDATE correction_resubmissions SET created_by_user_id = $2 WHERE id = $1", randomUUID()],
      ["created_at", "UPDATE correction_resubmissions SET created_at = created_at + interval '1 second' WHERE id = $1", null],
    ] as const;

    for (const [name, sql, value] of immutableUpdates) {
      await tx.query(`SAVEPOINT immutable_${name}`);
      const params = value === null ? [correction.rows[0].id] : [correction.rows[0].id, value];
      await expect(tx.query(sql, params)).rejects.toThrow();
      await tx.query(`ROLLBACK TO SAVEPOINT immutable_${name}`);
    }
  });

  it("extends auth audit event check with correction resubmission events", async () => {
    const constraint = await tx.query<{ definition: string }>(
      `
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'auth_audit_logs'::regclass
        AND conname = 'chk_auth_audit_logs_event_type'
      `,
    );

    expect(constraint.rows[0].definition).toContain("CORRECTION_RESUBMISSION_CREATED");
    expect(constraint.rows[0].definition).toContain("CORRECTION_RESUBMISSION_SUMMARY_UPDATED");
    expect(constraint.rows[0].definition).toContain("CORRECTION_RESUBMISSION_MARKED_READY");
    expect(constraint.rows[0].definition).toContain("CORRECTION_RESUBMISSION_VOIDED");
  });

  async function seedReturnedDecision(): Promise<{
    orgId: string;
    userId: string;
    assessmentCycleId: string;
    packageId: string;
    externalSubmissionId: string;
    intakeReviewId: string;
    decisionId: string;
  }> {
    const org = await tx.query<{ id: string }>(
      `INSERT INTO organizations (name, status) VALUES ($1, 'APPROVED') RETURNING id`,
      [`Correction Migration Org ${randomUUID()}`],
    );
    const user = await tx.query<{ id: string }>(
      `INSERT INTO users (org_id, email, password_hash, role, email_verified) VALUES ($1, $2, 'hash', 'admin', TRUE) RETURNING id`,
      [org.rows[0].id, `correction-migration-${randomUUID()}@example.com`],
    );
    const cycle = await tx.query<{ id: string }>(
      `INSERT INTO assessment_cycles (org_id, status, created_by_user_id, finalized_internal_by_user_id, finalized_internal_at) VALUES ($1, 'READY_FOR_SUBMISSION', $2, $2, now()) RETURNING id`,
      [org.rows[0].id, user.rows[0].id],
    );
    const snapshot = await tx.query<{ id: string }>(
      `INSERT INTO assessment_score_snapshots (assessment_cycle_id, org_id, overall_score, overall_label, total_requirements, applicable_requirements, not_applicable_requirements, calculated_by_user_id, calculated_at) VALUES ($1, $2, 70, 'SUBSTANTIALLY_COMPLIANT', 1, 1, 0, $3, now()) RETURNING id`,
      [cycle.rows[0].id, org.rows[0].id, user.rows[0].id],
    );
    const readiness = await tx.query<{ id: string }>(
      `INSERT INTO assessment_submission_readiness (org_id, assessment_cycle_id, confirmed_assessment_complete, confirmed_evidence_attached, confirmed_evidence_reviewed, confirmed_score_reviewed, confirmed_authorized_submitter, confirmed_information_accurate, declaration_text, declared_by_user_id) VALUES ($1, $2, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, $3, $4) RETURNING id`,
      [
        org.rows[0].id,
        cycle.rows[0].id,
        "I confirm that the information provided in this assessment is accurate to the best of my knowledge and that the evidence has been reviewed internally.",
        user.rows[0].id,
      ],
    );
    const pkg = await tx.query<{ id: string }>(
      `INSERT INTO assessment_submission_packages (org_id, assessment_cycle_id, score_snapshot_id, readiness_id, package_number, status, manifest_json, manifest_hash, created_by_user_id) VALUES ($1, $2, $3, $4, $5, 'CREATED', '{}'::jsonb, $6, $7) RETURNING id`,
      [
        org.rows[0].id,
        cycle.rows[0].id,
        snapshot.rows[0].id,
        readiness.rows[0].id,
        `SUB-20260426-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
        "a".repeat(64),
        user.rows[0].id,
      ],
    );
    const submission = await tx.query<{ id: string }>(
      `INSERT INTO external_submissions (org_id, submission_package_id, assessment_cycle_id, submission_number, status, submitted_by_user_id) VALUES ($1, $2, $3, $4, 'SUBMITTED', $5) RETURNING id`,
      [
        org.rows[0].id,
        pkg.rows[0].id,
        cycle.rows[0].id,
        `EXT-20260426-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
        user.rows[0].id,
      ],
    );
    const intake = await tx.query<{ id: string }>(
      `INSERT INTO pkcert_intake_reviews (external_submission_id, org_id, assessment_cycle_id, submission_package_id, status, assigned_to_user_id, assigned_at, started_by_user_id, started_at, reviewed_by_user_id, reviewed_at) VALUES ($1, $2, $3, $4, 'INTAKE_REVIEWED', $5, now(), $5, now(), $5, now()) RETURNING id`,
      [submission.rows[0].id, org.rows[0].id, cycle.rows[0].id, pkg.rows[0].id, user.rows[0].id],
    );
    const decision = await tx.query<{ id: string }>(
      `INSERT INTO pkcert_submission_decisions (external_submission_id, intake_review_id, org_id, assessment_cycle_id, submission_package_id, decision, decision_reason, decided_by_user_id) VALUES ($1, $2, $3, $4, $5, 'RETURNED_FOR_CORRECTION', $6, $7) RETURNING id`,
      [
        submission.rows[0].id,
        intake.rows[0].id,
        org.rows[0].id,
        cycle.rows[0].id,
        pkg.rows[0].id,
        "The submission requires correction because the package lacks sufficient support.",
        user.rows[0].id,
      ],
    );

    return {
      orgId: org.rows[0].id,
      userId: user.rows[0].id,
      assessmentCycleId: cycle.rows[0].id,
      packageId: pkg.rows[0].id,
      externalSubmissionId: submission.rows[0].id,
      intakeReviewId: intake.rows[0].id,
      decisionId: decision.rows[0].id,
    };
  }
});
