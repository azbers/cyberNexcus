import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

import { createPool } from "../src/db/pool.js";
import {
  beginIsolatedTestTransaction,
  DEFAULT_TEST_DATABASE_URL,
  rollbackAndRelease,
} from "./test-db.js";

describe("Evidence migrations", () => {
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

  it("creates assessment_evidence_files table and required indexes", async () => {
    const table = await tx.query<{ name: string }>(
      `
      SELECT to_regclass('public.assessment_evidence_files')::text AS name
      `,
    );
    expect(table.rows[0].name).toBe("assessment_evidence_files");

    const indexes = await tx.query<{ indexname: string }>(
      `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'assessment_evidence_files'
      `,
    );
    const names = new Set(indexes.rows.map((row) => row.indexname));
    expect(names.has("idx_assessment_evidence_org_cycle")).toBe(true);
    expect(names.has("idx_assessment_evidence_item_status")).toBe(true);
    expect(names.has("idx_assessment_evidence_sha256")).toBe(true);
    expect(names.has("idx_assessment_evidence_uploaded_by")).toBe(true);

    const columns = await tx.query<{ column_name: string }>(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'assessment_evidence_files'
      `,
    );
    const columnNames = new Set(columns.rows.map((row) => row.column_name));
    expect(columnNames.has("storage_path")).toBe(false);
    expect(columnNames.has("storage_backend")).toBe(true);
    expect(columnNames.has("storage_key")).toBe(true);
    expect(columnNames.has("validation_result_json")).toBe(true);

    const storageBackendCheck = await tx.query<{ definition: string }>(
      `
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'assessment_evidence_files'::regclass
        AND conname = 'chk_assessment_evidence_storage_backend'
      `,
    );
    expect(storageBackendCheck.rows).toHaveLength(1);
    expect(storageBackendCheck.rows[0].definition).toContain("LOCAL");
  });

  it("extends auth audit event check with evidence events", async () => {
    const constraint = await tx.query<{ definition: string }>(
      `
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'auth_audit_logs'::regclass
        AND conname = 'chk_auth_audit_logs_event_type'
      `,
    );
    expect(constraint.rows).toHaveLength(1);
    const definition = constraint.rows[0].definition;
    expect(definition).toContain("EVIDENCE_UPLOADED");
    expect(definition).toContain("EVIDENCE_REMOVED");
    expect(definition).toContain("EVIDENCE_DOWNLOADED");
  });
});
