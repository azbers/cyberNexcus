import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

import { createPool } from "../src/db/pool.js";
import {
  beginIsolatedTestTransaction,
  DEFAULT_TEST_DATABASE_URL,
  rollbackAndRelease,
} from "./test-db.js";

describe("Submission package migrations", () => {
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

  it("creates package table constraints, indexes, and immutability trigger", async () => {
    const table = await tx.query<{ name: string }>(
      `
      SELECT to_regclass('public.assessment_submission_packages')::text AS name
      `,
    );
    expect(table.rows[0].name).toBe("assessment_submission_packages");

    const constraints = await tx.query<{ definition: string; confdeltype: string }>(
      `
      SELECT pg_get_constraintdef(oid) AS definition, confdeltype
      FROM pg_constraint
      WHERE conrelid = 'assessment_submission_packages'::regclass
      ORDER BY conname
      `,
    );
    const definitions = constraints.rows.map((row) => row.definition).join("\n");

    expect(definitions).toContain("CREATED");
    expect(definitions).toContain("VOIDED");
    expect(definitions).toContain("manifest_hash ~ '^[0-9a-f]{64}$'");
    expect(definitions).toContain("length(btrim(void_reason)) >= 10");
    expect(definitions).toContain("length(btrim(void_reason)) <= 2000");
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
        AND tablename = 'assessment_submission_packages'
        AND indexname = 'uq_submission_packages_one_created_per_cycle'
      `,
    );
    expect(partialIndex.rows).toHaveLength(1);
    expect(partialIndex.rows[0].indexdef).toContain("WHERE (status = 'CREATED'::text)");

    const trigger = await tx.query<{ tgname: string }>(
      `
      SELECT tgname
      FROM pg_trigger
      WHERE tgrelid = 'assessment_submission_packages'::regclass
        AND tgname = 'assessment_submission_packages_immutable_fields'
        AND NOT tgisinternal
      `,
    );
    expect(trigger.rows).toHaveLength(1);
  });

  it("extends auth audit event check with package events", async () => {
    const constraint = await tx.query<{ definition: string }>(
      `
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'auth_audit_logs'::regclass
        AND conname = 'chk_auth_audit_logs_event_type'
      `,
    );

    expect(constraint.rows).toHaveLength(1);
    expect(constraint.rows[0].definition).toContain("SUBMISSION_PACKAGE_CREATED");
    expect(constraint.rows[0].definition).toContain("SUBMISSION_PACKAGE_VOIDED");
  });
});
