import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

import { createPool } from "../src/db/pool.js";
import {
  beginIsolatedTestTransaction,
  DEFAULT_TEST_DATABASE_URL,
  rollbackAndRelease,
} from "./test-db.js";

describe("Submission readiness migrations", () => {
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

  it("extends assessment cycle status and finalization consistency checks", async () => {
    const constraints = await tx.query<{ conname: string; definition: string }>(
      `
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'assessment_cycles'::regclass
        AND conname IN (
          'chk_assessment_cycles_status',
          'chk_assessment_cycles_finalization_consistency'
        )
      ORDER BY conname
      `,
    );
    const definitions = constraints.rows.map((row) => row.definition).join("\n");

    expect(definitions).toContain("READY_FOR_SUBMISSION");
    expect(definitions).toContain("FINALIZED_INTERNAL");
    expect(definitions).toContain("finalized_internal_by_user_id IS NOT NULL");
    expect(definitions).toContain("finalized_internal_at IS NOT NULL");
  });

  it("creates readiness table constraints and non-cascade foreign keys", async () => {
    const table = await tx.query<{ name: string }>(
      `
      SELECT to_regclass('public.assessment_submission_readiness')::text AS name
      `,
    );
    expect(table.rows[0].name).toBe("assessment_submission_readiness");

    const columns = await tx.query<{ column_name: string; is_nullable: string }>(
      `
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'assessment_submission_readiness'
        AND column_name IN (
          'confirmed_assessment_complete',
          'confirmed_evidence_attached',
          'confirmed_evidence_reviewed',
          'confirmed_score_reviewed',
          'confirmed_authorized_submitter',
          'confirmed_information_accurate',
          'declaration_text',
          'declared_by_user_id',
          'declared_at'
        )
      `,
    );
    expect(columns.rows.every((row) => row.is_nullable === "NO")).toBe(true);

    const constraints = await tx.query<{ definition: string; confdeltype: string }>(
      `
      SELECT pg_get_constraintdef(oid) AS definition, confdeltype
      FROM pg_constraint
      WHERE conrelid = 'assessment_submission_readiness'::regclass
      ORDER BY conname
      `,
    );
    const definitions = constraints.rows.map((row) => row.definition).join("\n");

    expect(definitions).toContain("UNIQUE (assessment_cycle_id)");
    expect(definitions).toContain("length(btrim(declaration_text)) >= 50");
    expect(definitions).toContain("length(btrim(declaration_text)) <= 2000");
    expect(definitions).toContain("length(review_notes) <= 5000");
    expect(
      constraints.rows
        .filter((row) => row.definition.startsWith("FOREIGN KEY"))
        .every((row) => row.confdeltype !== "c"),
    ).toBe(true);
  });

  it("extends auth audit event check with readiness events", async () => {
    const constraint = await tx.query<{ definition: string }>(
      `
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'auth_audit_logs'::regclass
        AND conname = 'chk_auth_audit_logs_event_type'
      `,
    );

    expect(constraint.rows).toHaveLength(1);
    expect(constraint.rows[0].definition).toContain("SUBMISSION_READINESS_UPSERTED");
    expect(constraint.rows[0].definition).toContain(
      "ASSESSMENT_MARKED_READY_FOR_SUBMISSION",
    );
  });
});
