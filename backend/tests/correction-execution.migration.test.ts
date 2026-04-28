import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import { createPool } from "../src/db/pool.js";
import {
  beginIsolatedTestTransaction,
  DEFAULT_TEST_DATABASE_URL,
  rollbackAndRelease,
} from "./test-db.js";

describe("correction execution migrations", () => {
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

  it("adds assessment cycle source fields, correction execution constraints, indexes, triggers, and FK restrictions", async () => {
    const cycleConstraints = await tx.query<{ conname: string; definition: string; confdeltype: string }>(
      `
      SELECT conname, pg_get_constraintdef(oid) AS definition, confdeltype
      FROM pg_constraint
      WHERE conrelid = 'assessment_cycles'::regclass
      ORDER BY conname
      `,
    );
    const cycleDefinitions = cycleConstraints.rows.map((row) => row.definition).join("\n");
    expect(cycleDefinitions).toContain("NORMAL");
    expect(cycleDefinitions).toContain("CORRECTION");
    expect(cycleDefinitions).toContain("source_correction_resubmission_id IS NULL");
    expect(cycleDefinitions).toContain("source_assessment_cycle_id IS NOT NULL");
    expect(
      cycleConstraints.rows
        .filter((row) => row.definition.startsWith("FOREIGN KEY") && row.conname.includes("source"))
        .every((row) => row.confdeltype === "r"),
    ).toBe(true);

    const normalDraftIndex = await tx.query<{ indexdef: string }>(
      `
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'uq_assessment_cycles_one_normal_draft_per_org'
      `,
    );
    expect(normalDraftIndex.rows[0].indexdef).toContain("status = 'DRAFT'::text");
    expect(normalDraftIndex.rows[0].indexdef).toContain("cycle_type = 'NORMAL'::text");

    const table = await tx.query<{ name: string }>(
      `SELECT to_regclass('public.correction_execution_cycles')::text AS name`,
    );
    expect(table.rows[0].name).toBe("correction_execution_cycles");

    const constraints = await tx.query<{ conname: string; definition: string; confdeltype: string }>(
      `
      SELECT conname, pg_get_constraintdef(oid) AS definition, confdeltype
      FROM pg_constraint
      WHERE conrelid = 'correction_execution_cycles'::regclass
      ORDER BY conname
      `,
    );
    const definitions = constraints.rows.map((row) => row.definition).join("\n");
    expect(definitions).toContain("CREATED");
    expect(definitions).toContain("VOIDED");
    expect(definitions).toContain("length(btrim(void_reason)) >= 10");
    expect(definitions).toContain("length(btrim(void_reason)) <= 2000");
    expect(definitions).toContain("UNIQUE (correction_assessment_cycle_id)");
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
        AND tablename = 'correction_execution_cycles'
      ORDER BY indexname
      `,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "idx_correction_execution_cycles_org",
        "idx_correction_execution_cycles_correction_resubmission",
        "idx_correction_execution_cycles_original_cycle",
        "idx_correction_execution_cycles_correction_cycle",
        "idx_correction_execution_cycles_status",
        "idx_correction_execution_cycles_created_at",
        "uq_active_correction_execution_per_correction",
      ]),
    );
    expect(
      indexes.rows.find((row) => row.indexname === "uq_active_correction_execution_per_correction")?.indexdef,
    ).toContain("WHERE (status = 'CREATED'::text)");

    const triggers = await tx.query<{ tgname: string }>(
      `
      SELECT tgname
      FROM pg_trigger
      WHERE tgrelid = 'correction_execution_cycles'::regclass
        AND NOT tgisinternal
      `,
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual(
      expect.arrayContaining([
        "correction_execution_cycles_immutable_identity",
        "correction_execution_cycles_00_set_updated_at",
      ]),
    );
  });

  it("prevents direct DB changes to immutable correction execution identity fields", async () => {
    const seeded = await seedExecution();
    const immutableUpdates = [
      ["org_id", "UPDATE correction_execution_cycles SET org_id = $2 WHERE id = $1", randomUUID()],
      ["correction_resubmission_id", "UPDATE correction_execution_cycles SET correction_resubmission_id = $2 WHERE id = $1", randomUUID()],
      ["original_assessment_cycle_id", "UPDATE correction_execution_cycles SET original_assessment_cycle_id = $2 WHERE id = $1", randomUUID()],
      ["correction_assessment_cycle_id", "UPDATE correction_execution_cycles SET correction_assessment_cycle_id = $2 WHERE id = $1", randomUUID()],
      ["created_by_user_id", "UPDATE correction_execution_cycles SET created_by_user_id = $2 WHERE id = $1", randomUUID()],
      ["created_at", "UPDATE correction_execution_cycles SET created_at = created_at + interval '1 second' WHERE id = $1", null],
    ] as const;

    for (const [name, sql, value] of immutableUpdates) {
      await tx.query(`SAVEPOINT immutable_${name}`);
      const params = value === null ? [seeded.executionId] : [seeded.executionId, value];
      await expect(tx.query(sql, params)).rejects.toThrow();
      await tx.query(`ROLLBACK TO SAVEPOINT immutable_${name}`);
    }
  });

  it("extends auth audit event check with correction execution events", async () => {
    const constraint = await tx.query<{ definition: string }>(
      `
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'auth_audit_logs'::regclass
        AND conname = 'chk_auth_audit_logs_event_type'
      `,
    );

    expect(constraint.rows[0].definition).toContain("CORRECTION_EXECUTION_CYCLE_CREATED");
    expect(constraint.rows[0].definition).toContain("CORRECTION_EXECUTION_CYCLE_VOIDED");
  });

  async function seedExecution(): Promise<{ executionId: string }> {
    const org = await tx.query<{ id: string }>(
      `INSERT INTO organizations (name, status) VALUES ($1, 'APPROVED') RETURNING id`,
      [`Correction Execution Migration Org ${randomUUID()}`],
    );
    const user = await tx.query<{ id: string }>(
      `INSERT INTO users (org_id, email, password_hash, role, email_verified) VALUES ($1, $2, 'hash', 'admin', TRUE) RETURNING id`,
      [org.rows[0].id, `correction-execution-migration-${randomUUID()}@example.com`],
    );
    const originalCycle = await tx.query<{ id: string }>(
      `INSERT INTO assessment_cycles (org_id, status, created_by_user_id, finalized_internal_by_user_id, finalized_internal_at) VALUES ($1, 'READY_FOR_SUBMISSION', $2, $2, now()) RETURNING id`,
      [org.rows[0].id, user.rows[0].id],
    );
    const snapshot = await tx.query<{ id: string }>(
      `INSERT INTO assessment_score_snapshots (assessment_cycle_id, org_id, overall_score, overall_label, total_requirements, applicable_requirements, not_applicable_requirements, calculated_by_user_id, calculated_at) VALUES ($1, $2, 70, 'SUBSTANTIALLY_COMPLIANT', 1, 1, 0, $3, now()) RETURNING id`,
      [originalCycle.rows[0].id, org.rows[0].id, user.rows[0].id],
    );
    const readiness = await tx.query<{ id: string }>(
      `INSERT INTO assessment_submission_readiness (org_id, assessment_cycle_id, confirmed_assessment_complete, confirmed_evidence_attached, confirmed_evidence_reviewed, confirmed_score_reviewed, confirmed_authorized_submitter, confirmed_information_accurate, declaration_text, declared_by_user_id) VALUES ($1, $2, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, $3, $4) RETURNING id`,
      [org.rows[0].id, originalCycle.rows[0].id, "I confirm that the information provided in this assessment is accurate to the best of my knowledge and that the evidence has been reviewed internally.", user.rows[0].id],
    );
    const pkg = await tx.query<{ id: string }>(
      `INSERT INTO assessment_submission_packages (org_id, assessment_cycle_id, score_snapshot_id, readiness_id, package_number, status, manifest_json, manifest_hash, created_by_user_id) VALUES ($1, $2, $3, $4, $5, 'CREATED', '{}'::jsonb, $6, $7) RETURNING id`,
      [org.rows[0].id, originalCycle.rows[0].id, snapshot.rows[0].id, readiness.rows[0].id, `SUB-20260426-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`, "a".repeat(64), user.rows[0].id],
    );
    const submission = await tx.query<{ id: string }>(
      `INSERT INTO external_submissions (org_id, submission_package_id, assessment_cycle_id, submission_number, status, submitted_by_user_id) VALUES ($1, $2, $3, $4, 'SUBMITTED', $5) RETURNING id`,
      [org.rows[0].id, pkg.rows[0].id, originalCycle.rows[0].id, `EXT-20260426-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`, user.rows[0].id],
    );
    const intake = await tx.query<{ id: string }>(
      `INSERT INTO pkcert_intake_reviews (external_submission_id, org_id, assessment_cycle_id, submission_package_id, status, assigned_to_user_id, assigned_at, started_by_user_id, started_at, reviewed_by_user_id, reviewed_at) VALUES ($1, $2, $3, $4, 'INTAKE_REVIEWED', $5, now(), $5, now(), $5, now()) RETURNING id`,
      [submission.rows[0].id, org.rows[0].id, originalCycle.rows[0].id, pkg.rows[0].id, user.rows[0].id],
    );
    const decision = await tx.query<{ id: string }>(
      `INSERT INTO pkcert_submission_decisions (external_submission_id, intake_review_id, org_id, assessment_cycle_id, submission_package_id, decision, decision_reason, decided_by_user_id) VALUES ($1, $2, $3, $4, $5, 'RETURNED_FOR_CORRECTION', $6, $7) RETURNING id`,
      [submission.rows[0].id, intake.rows[0].id, org.rows[0].id, originalCycle.rows[0].id, pkg.rows[0].id, "The submission requires correction because the package lacks sufficient support.", user.rows[0].id],
    );
    const correction = await tx.query<{ id: string }>(
      `INSERT INTO correction_resubmissions (org_id, original_external_submission_id, original_decision_id, original_submission_package_id, original_assessment_cycle_id, status, correction_reason, correction_summary, created_by_user_id, ready_by_user_id, ready_at) VALUES ($1, $2, $3, $4, $5, 'READY_FOR_RESUBMISSION', $6, $7, $8, $8, now()) RETURNING id`,
      [org.rows[0].id, submission.rows[0].id, decision.rows[0].id, pkg.rows[0].id, originalCycle.rows[0].id, "PKCERT returned the submission for correction because evidence was insufficient.", "Corrected summary is sufficient for execution.", user.rows[0].id],
    );
    const correctionCycle = await tx.query<{ id: string }>(
      `INSERT INTO assessment_cycles (org_id, status, cycle_type, source_correction_resubmission_id, source_assessment_cycle_id, created_by_user_id) VALUES ($1, 'DRAFT', 'CORRECTION', $2, $3, $4) RETURNING id`,
      [org.rows[0].id, correction.rows[0].id, originalCycle.rows[0].id, user.rows[0].id],
    );
    const execution = await tx.query<{ id: string }>(
      `INSERT INTO correction_execution_cycles (org_id, correction_resubmission_id, original_assessment_cycle_id, correction_assessment_cycle_id, status, created_by_user_id) VALUES ($1, $2, $3, $4, 'CREATED', $5) RETURNING id`,
      [org.rows[0].id, correction.rows[0].id, originalCycle.rows[0].id, correctionCycle.rows[0].id, user.rows[0].id],
    );
    return { executionId: execution.rows[0].id };
  }
});
