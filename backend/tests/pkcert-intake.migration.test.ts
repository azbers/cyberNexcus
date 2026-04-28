import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import { createPool } from "../src/db/pool.js";
import {
  beginIsolatedTestTransaction,
  DEFAULT_TEST_DATABASE_URL,
  rollbackAndRelease,
} from "./test-db.js";

describe("PKCERT intake migrations", () => {
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

  it("creates pkcert intake tables, constraints, indexes, and triggers", async () => {
    const tables = await tx.query<{ table_name: string }>(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('pkcert_users', 'pkcert_intake_reviews')
      ORDER BY table_name
      `,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "pkcert_intake_reviews",
      "pkcert_users",
    ]);

    const constraints = await tx.query<{
      table_name: string;
      conname: string;
      definition: string;
      confdeltype: string;
    }>(
      `
      SELECT
        c.relname AS table_name,
        con.conname,
        pg_get_constraintdef(con.oid) AS definition,
        con.confdeltype
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      WHERE c.relname IN ('pkcert_users', 'pkcert_intake_reviews')
      ORDER BY c.relname, con.conname
      `,
    );
    const definitions = constraints.rows.map((row) => row.definition).join("\n");
    expect(definitions).toContain("PKCERT_ADMIN");
    expect(definitions).toContain("PKCERT_REVIEWER");
    expect(definitions).toContain("PENDING_INTAKE");
    expect(definitions).toContain("IN_INTAKE_REVIEW");
    expect(definitions).toContain("INTAKE_REVIEWED");
    expect(definitions).toContain("length(internal_notes) <= 5000");
    expect(definitions).toContain("UNIQUE (external_submission_id)");
    expect(
      constraints.rows
        .filter((row) => row.definition.startsWith("FOREIGN KEY"))
        .every((row) => row.confdeltype !== "c"),
    ).toBe(true);

    const indexes = await tx.query<{ indexname: string }>(
      `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'pkcert_intake_reviews'
      `,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "idx_pkcert_intake_reviews_status",
        "idx_pkcert_intake_reviews_org",
        "idx_pkcert_intake_reviews_external_submission",
        "idx_pkcert_intake_reviews_assigned_to",
        "idx_pkcert_intake_reviews_created_at",
      ]),
    );

    const triggers = await tx.query<{ tgname: string }>(
      `
      SELECT tgname
      FROM pg_trigger
      WHERE tgrelid IN ('pkcert_users'::regclass, 'pkcert_intake_reviews'::regclass)
        AND NOT tgisinternal
      `,
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual(
      expect.arrayContaining([
        "pkcert_users_set_updated_at",
        "pkcert_intake_reviews_set_updated_at",
        "pkcert_intake_reviews_immutable_identity",
      ]),
    );
  });

  it("prevents direct DB changes to immutable intake identity fields", async () => {
    const seeded = await seedSubmittedExternalSubmission();
    const intake = await tx.query<{ id: string }>(
      `
      INSERT INTO pkcert_intake_reviews (
        external_submission_id,
        org_id,
        assessment_cycle_id,
        submission_package_id,
        status
      )
      VALUES ($1, $2, $3, $4, 'PENDING_INTAKE')
      RETURNING id
      `,
      [
        seeded.externalSubmissionId,
        seeded.orgId,
        seeded.assessmentCycleId,
        seeded.packageId,
      ],
    );

    const immutableUpdates = [
      {
        name: "external_submission_id",
        sql: "UPDATE pkcert_intake_reviews SET external_submission_id = $2 WHERE id = $1",
        params: [intake.rows[0].id, randomUUID()],
      },
      {
        name: "org_id",
        sql: "UPDATE pkcert_intake_reviews SET org_id = $2 WHERE id = $1",
        params: [intake.rows[0].id, randomUUID()],
      },
      {
        name: "assessment_cycle_id",
        sql: "UPDATE pkcert_intake_reviews SET assessment_cycle_id = $2 WHERE id = $1",
        params: [intake.rows[0].id, randomUUID()],
      },
      {
        name: "submission_package_id",
        sql: "UPDATE pkcert_intake_reviews SET submission_package_id = $2 WHERE id = $1",
        params: [intake.rows[0].id, randomUUID()],
      },
      {
        name: "created_at",
        sql: "UPDATE pkcert_intake_reviews SET created_at = created_at + interval '1 second' WHERE id = $1",
        params: [intake.rows[0].id],
      },
    ];

    for (const update of immutableUpdates) {
      await tx.query(`SAVEPOINT immutable_${update.name}`);
      await expect(tx.query(update.sql, update.params)).rejects.toThrow();
      await tx.query(`ROLLBACK TO SAVEPOINT immutable_${update.name}`);
    }
  });

  it("backfills pending intake rows for submitted external submissions only", async () => {
    const submitted = await seedSubmittedExternalSubmission("SUBMITTED");
    const withdrawn = await seedSubmittedExternalSubmission("WITHDRAWN");

    await tx.query(
      `
      INSERT INTO pkcert_intake_reviews (
        external_submission_id,
        org_id,
        assessment_cycle_id,
        submission_package_id,
        status
      )
      SELECT
        es.id,
        es.org_id,
        es.assessment_cycle_id,
        es.submission_package_id,
        'PENDING_INTAKE'
      FROM external_submissions es
      WHERE es.status = 'SUBMITTED'
        AND NOT EXISTS (
          SELECT 1
          FROM pkcert_intake_reviews pir
          WHERE pir.external_submission_id = es.id
        )
      `,
    );

    const rows = await tx.query<{ external_submission_id: string }>(
      `
      SELECT external_submission_id
      FROM pkcert_intake_reviews
      WHERE external_submission_id IN ($1, $2)
      `,
      [submitted.externalSubmissionId, withdrawn.externalSubmissionId],
    );
    expect(rows.rows.map((row) => row.external_submission_id)).toEqual([
      submitted.externalSubmissionId,
    ]);
  });

  it("extends auth audit event check with PKCERT intake events", async () => {
    const constraint = await tx.query<{ definition: string }>(
      `
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'auth_audit_logs'::regclass
        AND conname = 'chk_auth_audit_logs_event_type'
      `,
    );

    expect(constraint.rows).toHaveLength(1);
    expect(constraint.rows[0].definition).toContain("PKCERT_INTAKE_CREATED");
    expect(constraint.rows[0].definition).toContain("PKCERT_INTAKE_ASSIGNED");
    expect(constraint.rows[0].definition).toContain("PKCERT_INTAKE_STARTED");
    expect(constraint.rows[0].definition).toContain("PKCERT_INTAKE_REVIEWED");
    expect(constraint.rows[0].definition).toContain("PKCERT_INTAKE_NOTES_UPDATED");
  });

  async function seedSubmittedExternalSubmission(
    status: "SUBMITTED" | "WITHDRAWN" = "SUBMITTED",
  ): Promise<{
    orgId: string;
    userId: string;
    assessmentCycleId: string;
    packageId: string;
    externalSubmissionId: string;
  }> {
    const org = await tx.query<{ id: string }>(
      `
      INSERT INTO organizations (name, status)
      VALUES ($1, 'APPROVED')
      RETURNING id
      `,
      [`PKCERT Migration Org ${randomUUID()}`],
    );
    const user = await tx.query<{ id: string }>(
      `
      INSERT INTO users (org_id, email, password_hash, role, email_verified)
      VALUES ($1, $2, 'hash', 'admin', TRUE)
      RETURNING id
      `,
      [org.rows[0].id, `pkcert-migration-${randomUUID()}@example.com`],
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
        `SUB-20260425-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
        "a".repeat(64),
        user.rows[0].id,
      ],
    );
    const submitted =
      status === "SUBMITTED"
        ? await tx.query<{ id: string }>(
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
              `EXT-20260425-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
              user.rows[0].id,
            ],
          )
        : await tx.query<{ id: string }>(
            `
            INSERT INTO external_submissions (
              org_id,
              submission_package_id,
              assessment_cycle_id,
              submission_number,
              status,
              submitted_by_user_id,
              withdrawn_by_user_id,
              withdrawn_at,
              withdraw_reason
            )
            VALUES ($1, $2, $3, $4, 'WITHDRAWN', $5, $5, now(), 'Withdrawn for migration coverage.')
            RETURNING id
            `,
            [
              org.rows[0].id,
              pkg.rows[0].id,
              cycle.rows[0].id,
              `EXT-20260425-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
              user.rows[0].id,
            ],
          );

    return {
      orgId: org.rows[0].id,
      userId: user.rows[0].id,
      assessmentCycleId: cycle.rows[0].id,
      packageId: pkg.rows[0].id,
      externalSubmissionId: submitted.rows[0].id,
    };
  }
});
