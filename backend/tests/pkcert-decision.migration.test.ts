import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import { createPool } from "../src/db/pool.js";
import {
  beginIsolatedTestTransaction,
  DEFAULT_TEST_DATABASE_URL,
  rollbackAndRelease,
} from "./test-db.js";

describe("PKCERT decision migrations", () => {
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

  it("creates decision table constraints, indexes, triggers, and FK restrictions", async () => {
    const table = await tx.query<{ name: string }>(
      `
      SELECT to_regclass('public.pkcert_submission_decisions')::text AS name
      `,
    );
    expect(table.rows[0].name).toBe("pkcert_submission_decisions");

    const constraints = await tx.query<{
      conname: string;
      definition: string;
      confdeltype: string;
    }>(
      `
      SELECT conname, pg_get_constraintdef(oid) AS definition, confdeltype
      FROM pg_constraint
      WHERE conrelid = 'pkcert_submission_decisions'::regclass
      ORDER BY conname
      `,
    );
    const definitions = constraints.rows.map((row) => row.definition).join("\n");
    expect(definitions).toContain("ACCEPTED");
    expect(definitions).toContain("REJECTED");
    expect(definitions).toContain("RETURNED_FOR_CORRECTION");
    expect(definitions).toContain("length(btrim(decision_reason)) >= 20");
    expect(definitions).toContain("length(btrim(decision_reason)) <= 5000");
    expect(definitions).toContain("UNIQUE (external_submission_id)");
    expect(
      constraints.rows
        .filter((row) => row.definition.startsWith("FOREIGN KEY"))
        .every((row) => row.confdeltype === "r"),
    ).toBe(true);

    const indexes = await tx.query<{ indexname: string }>(
      `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'pkcert_submission_decisions'
      `,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "idx_pkcert_submission_decisions_org",
        "idx_pkcert_submission_decisions_external_submission",
        "idx_pkcert_submission_decisions_intake_review",
        "idx_pkcert_submission_decisions_decision",
        "idx_pkcert_submission_decisions_decided_at",
      ]),
    );

    const triggers = await tx.query<{ tgname: string }>(
      `
      SELECT tgname
      FROM pg_trigger
      WHERE tgrelid = 'pkcert_submission_decisions'::regclass
        AND NOT tgisinternal
      `,
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual(
      expect.arrayContaining([
        "pkcert_submission_decisions_immutable",
        "pkcert_submission_decisions_00_set_updated_at",
      ]),
    );
  });

  it("prevents direct DB changes to every immutable decision field including updated_at", async () => {
    const seeded = await seedReviewedSubmission();
    const decision = await tx.query<{ id: string }>(
      `
      INSERT INTO pkcert_submission_decisions (
        external_submission_id,
        intake_review_id,
        org_id,
        assessment_cycle_id,
        submission_package_id,
        decision,
        decision_reason,
        decided_by_user_id
      )
      VALUES ($1, $2, $3, $4, $5, 'ACCEPTED', $6, $7)
      RETURNING id
      `,
      [
        seeded.externalSubmissionId,
        seeded.intakeReviewId,
        seeded.orgId,
        seeded.assessmentCycleId,
        seeded.packageId,
        "The submitted package has completed intake review and is accepted.",
        seeded.userId,
      ],
    );

    const immutableUpdates = [
      ["external_submission_id", "UPDATE pkcert_submission_decisions SET external_submission_id = $2 WHERE id = $1", randomUUID()],
      ["intake_review_id", "UPDATE pkcert_submission_decisions SET intake_review_id = $2 WHERE id = $1", randomUUID()],
      ["org_id", "UPDATE pkcert_submission_decisions SET org_id = $2 WHERE id = $1", randomUUID()],
      ["assessment_cycle_id", "UPDATE pkcert_submission_decisions SET assessment_cycle_id = $2 WHERE id = $1", randomUUID()],
      ["submission_package_id", "UPDATE pkcert_submission_decisions SET submission_package_id = $2 WHERE id = $1", randomUUID()],
      ["decision", "UPDATE pkcert_submission_decisions SET decision = $2 WHERE id = $1", "REJECTED"],
      ["decision_reason", "UPDATE pkcert_submission_decisions SET decision_reason = $2 WHERE id = $1", "A different decision reason that is long enough."],
      ["decided_by_user_id", "UPDATE pkcert_submission_decisions SET decided_by_user_id = $2 WHERE id = $1", randomUUID()],
      ["decided_at", "UPDATE pkcert_submission_decisions SET decided_at = decided_at + interval '1 second' WHERE id = $1", null],
      ["created_at", "UPDATE pkcert_submission_decisions SET created_at = created_at + interval '1 second' WHERE id = $1", null],
      ["updated_at", "UPDATE pkcert_submission_decisions SET updated_at = updated_at + interval '1 second' WHERE id = $1", null],
    ] as const;

    for (const [name, sql, value] of immutableUpdates) {
      await tx.query(`SAVEPOINT immutable_${name}`);
      const params = value === null ? [decision.rows[0].id] : [decision.rows[0].id, value];
      await expect(tx.query(sql, params)).rejects.toThrow();
      await tx.query(`ROLLBACK TO SAVEPOINT immutable_${name}`);
    }
  });

  it("extends auth audit event check with PKCERT decision event", async () => {
    const constraint = await tx.query<{ definition: string }>(
      `
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'auth_audit_logs'::regclass
        AND conname = 'chk_auth_audit_logs_event_type'
      `,
    );

    expect(constraint.rows).toHaveLength(1);
    expect(constraint.rows[0].definition).toContain("PKCERT_DECISION_RECORDED");
  });

  async function seedReviewedSubmission(): Promise<{
    orgId: string;
    userId: string;
    assessmentCycleId: string;
    packageId: string;
    externalSubmissionId: string;
    intakeReviewId: string;
  }> {
    const org = await tx.query<{ id: string }>(
      `
      INSERT INTO organizations (name, status)
      VALUES ($1, 'APPROVED')
      RETURNING id
      `,
      [`PKCERT Decision Migration Org ${randomUUID()}`],
    );
    const user = await tx.query<{ id: string }>(
      `
      INSERT INTO users (org_id, email, password_hash, role, email_verified)
      VALUES ($1, $2, 'hash', 'admin', TRUE)
      RETURNING id
      `,
      [org.rows[0].id, `decision-migration-${randomUUID()}@example.com`],
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
      VALUES ($1, 'READY_FOR_SUBMISSION', $2, $2, now())
      RETURNING id
      `,
      [org.rows[0].id, user.rows[0].id],
    );
    const snapshot = await tx.query<{ id: string }>(
      `
      INSERT INTO assessment_score_snapshots (
        assessment_cycle_id,
        org_id,
        overall_score,
        overall_label,
        total_requirements,
        applicable_requirements,
        not_applicable_requirements,
        calculated_by_user_id,
        calculated_at
      )
      VALUES ($1, $2, 100, 'COMPLIANT', 1, 1, 0, $3, now())
      RETURNING id
      `,
      [cycle.rows[0].id, org.rows[0].id, user.rows[0].id],
    );
    const readiness = await tx.query<{ id: string }>(
      `
      INSERT INTO assessment_submission_readiness (
        org_id,
        assessment_cycle_id,
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
      VALUES (
        $1, $2, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE,
        'I confirm that the information provided in this assessment is accurate to the best of my knowledge and that the evidence has been reviewed internally.',
        $3,
        now()
      )
      RETURNING id
      `,
      [org.rows[0].id, cycle.rows[0].id, user.rows[0].id],
    );
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
        created_by_user_id
      )
      VALUES ($1, $2, $3, $4, $5, 'CREATED', '{}'::jsonb, $6, $7)
      RETURNING id
      `,
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
      `
      INSERT INTO external_submissions (
        org_id,
        submission_package_id,
        assessment_cycle_id,
        submission_number,
        status,
        submitted_by_user_id
      )
      VALUES ($1, $2, $3, $4, 'SUBMITTED', $5)
      RETURNING id
      `,
      [
        org.rows[0].id,
        pkg.rows[0].id,
        cycle.rows[0].id,
        `EXT-20260426-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
        user.rows[0].id,
      ],
    );
    const intake = await tx.query<{ id: string }>(
      `
      INSERT INTO pkcert_intake_reviews (
        external_submission_id,
        org_id,
        assessment_cycle_id,
        submission_package_id,
        status,
        assigned_to_user_id,
        assigned_at,
        started_by_user_id,
        started_at,
        reviewed_by_user_id,
        reviewed_at
      )
      VALUES ($1, $2, $3, $4, 'INTAKE_REVIEWED', $5, now(), $5, now(), $5, now())
      RETURNING id
      `,
      [
        submission.rows[0].id,
        org.rows[0].id,
        cycle.rows[0].id,
        pkg.rows[0].id,
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
    };
  }
});
