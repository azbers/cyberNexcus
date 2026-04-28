import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import { createPool } from "../src/db/pool.js";
import {
  beginIsolatedTestTransaction,
  DEFAULT_TEST_DATABASE_URL,
  rollbackAndRelease,
} from "./test-db.js";

describe("External submission migrations", () => {
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

  it("creates external submission constraints, indexes, and immutability trigger", async () => {
    const table = await tx.query<{ name: string }>(
      `
      SELECT to_regclass('public.external_submissions')::text AS name
      `,
    );
    expect(table.rows[0].name).toBe("external_submissions");

    const constraints = await tx.query<{
      conname: string;
      definition: string;
      confdeltype: string;
    }>(
      `
      SELECT conname, pg_get_constraintdef(oid) AS definition, confdeltype
      FROM pg_constraint
      WHERE conrelid = 'external_submissions'::regclass
      ORDER BY conname
      `,
    );
    const definitions = constraints.rows.map((row) => row.definition).join("\n");

    expect(definitions).toContain("SUBMITTED");
    expect(definitions).toContain("WITHDRAWN");
    expect(definitions).toContain("length(btrim(withdraw_reason)) >= 10");
    expect(definitions).toContain("length(btrim(withdraw_reason)) <= 2000");
    expect(
      constraints.rows
        .filter((row) => row.definition.startsWith("FOREIGN KEY"))
        .every((row) => row.confdeltype !== "c"),
    ).toBe(true);

    const partialIndex = await tx.query<{ indexdef: string }>(
      `
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'external_submissions'
        AND indexname = 'uq_external_submissions_one_submitted_per_package'
      `,
    );
    expect(partialIndex.rows).toHaveLength(1);
    expect(partialIndex.rows[0].indexdef).toContain("WHERE (status = 'SUBMITTED'::text)");

    const indexes = await tx.query<{ indexname: string }>(
      `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'external_submissions'
      `,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "idx_external_submissions_org",
        "idx_external_submissions_cycle",
        "idx_external_submissions_package",
        "idx_external_submissions_submission_number",
        "idx_external_submissions_status",
      ]),
    );

    const trigger = await tx.query<{ tgname: string }>(
      `
      SELECT tgname
      FROM pg_trigger
      WHERE tgrelid = 'external_submissions'::regclass
        AND tgname IN (
          'external_submissions_immutable_fields',
          'external_submissions_set_updated_at'
        )
        AND NOT tgisinternal
      `,
    );
    expect(trigger.rows.map((row) => row.tgname).sort()).toEqual([
      "external_submissions_immutable_fields",
      "external_submissions_set_updated_at",
    ]);
  });

  it("prevents direct DB changes to immutable submitted identity fields", async () => {
    const org = await tx.query<{ id: string }>(
      `
      INSERT INTO organizations (name, status)
      VALUES ('External Submission Migration Org', 'APPROVED')
      RETURNING id
      `,
    );
    const user = await tx.query<{ id: string }>(
      `
      INSERT INTO users (org_id, email, password_hash, role, email_verified)
      VALUES ($1, 'external-submission-migration@example.com', 'hash', 'admin', TRUE)
      RETURNING id
      `,
      [org.rows[0].id],
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
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'SUB-20260425-ABCDEF12',
        'CREATED',
        '{}'::jsonb,
        $5,
        $6
      )
      RETURNING id
      `,
      [org.rows[0].id, cycle.rows[0].id, snapshot.rows[0].id, readiness.rows[0].id, "a".repeat(64), user.rows[0].id],
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
      VALUES ($1, $2, $3, 'EXT-20260425-ABCDEF12', 'SUBMITTED', $4)
      RETURNING id
      `,
      [org.rows[0].id, pkg.rows[0].id, cycle.rows[0].id, user.rows[0].id],
    );

    const immutableUpdates = [
      {
        name: "submission_number",
        sql: "UPDATE external_submissions SET submission_number = 'EXT-20260425-FFFFFFFF' WHERE id = $1",
        params: [submission.rows[0].id],
      },
      {
        name: "org_id",
        sql: "UPDATE external_submissions SET org_id = $2 WHERE id = $1",
        params: [submission.rows[0].id, randomUUID()],
      },
      {
        name: "submission_package_id",
        sql: "UPDATE external_submissions SET submission_package_id = $2 WHERE id = $1",
        params: [submission.rows[0].id, randomUUID()],
      },
      {
        name: "assessment_cycle_id",
        sql: "UPDATE external_submissions SET assessment_cycle_id = $2 WHERE id = $1",
        params: [submission.rows[0].id, randomUUID()],
      },
      {
        name: "submitted_by_user_id",
        sql: "UPDATE external_submissions SET submitted_by_user_id = $2 WHERE id = $1",
        params: [submission.rows[0].id, randomUUID()],
      },
      {
        name: "submitted_at",
        sql: "UPDATE external_submissions SET submitted_at = submitted_at + interval '1 second' WHERE id = $1",
        params: [submission.rows[0].id],
      },
      {
        name: "created_at",
        sql: "UPDATE external_submissions SET created_at = created_at + interval '1 second' WHERE id = $1",
        params: [submission.rows[0].id],
      },
    ];

    for (const update of immutableUpdates) {
      await tx.query(`SAVEPOINT immutable_${update.name}`);
      await expect(tx.query(update.sql, update.params)).rejects.toThrow();
      await tx.query(`ROLLBACK TO SAVEPOINT immutable_${update.name}`);
    }
  });

  it("extends auth audit event check with external submission events", async () => {
    const constraint = await tx.query<{ definition: string }>(
      `
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'auth_audit_logs'::regclass
        AND conname = 'chk_auth_audit_logs_event_type'
      `,
    );

    expect(constraint.rows).toHaveLength(1);
    expect(constraint.rows[0].definition).toContain("EXTERNAL_SUBMISSION_CREATED");
    expect(constraint.rows[0].definition).toContain("EXTERNAL_SUBMISSION_WITHDRAWN");
  });
});
