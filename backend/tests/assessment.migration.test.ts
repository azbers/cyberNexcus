import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

import { createPool } from "../src/db/pool.js";
import {
  beginIsolatedTestTransaction,
  DEFAULT_TEST_DATABASE_URL,
  rollbackAndRelease,
} from "./test-db.js";

describe("Assessment migrations", () => {
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

  it("creates assessment tables and one-draft partial unique index", async () => {
    const tables = await tx.query<{ name: string }>(
      `
      SELECT unnest(ARRAY[
        to_regclass('public.assessment_cycles')::text,
        to_regclass('public.assessment_requirement_items')::text
      ]) AS name
      `,
    );

    expect(tables.rows.map((row) => row.name)).toEqual([
      "assessment_cycles",
      "assessment_requirement_items",
    ]);

    const index = await tx.query<{ indexdef: string }>(
      `
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'assessment_cycles'
        AND indexname = 'uq_assessment_cycles_one_draft_per_org'
      `,
    );
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0].indexdef.toUpperCase()).toContain("WHERE");
    expect(index.rows[0].indexdef).toContain("status");
  });

  it("enforces non-cascade delete on assessment_requirement_items -> assessment_cycles FK", async () => {
    const fk = await tx.query<{ confdeltype: string; definition: string }>(
      `
      SELECT
        c.confdeltype,
        pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      WHERE c.conrelid = 'assessment_requirement_items'::regclass
        AND c.contype = 'f'
        AND pg_get_constraintdef(c.oid) ILIKE '%(assessment_cycle_id)%'
      LIMIT 1
      `,
    );

    expect(fk.rows).toHaveLength(1);
    expect(fk.rows[0].confdeltype).not.toBe("c");
  });

  it("extends auth audit event check with assessment lifecycle events", async () => {
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
    expect(definition).toContain("ASSESSMENT_DRAFT_CREATED");
    expect(definition).toContain("ASSESSMENT_ITEM_STATUS_UPDATED");
    expect(definition).toContain("ASSESSMENT_INTERNAL_FINALIZED");
  });

  it("creates evidence checklist table with required constraints", async () => {
    const table = await tx.query<{ name: string }>(
      `
      SELECT to_regclass('public.assessment_evidence_checklists')::text AS name
      `,
    );
    expect(table.rows[0].name).toBe("assessment_evidence_checklists");

    const requiredColumns = await tx.query<{ column_name: string; is_nullable: string }>(
      `
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'assessment_evidence_checklists'
        AND column_name IN (
          'dated_within_12_months',
          'organization_specific',
          'addresses_requirement',
          'approved_by_authority',
          'currently_in_force',
          'evidence_quality',
          'reviewed_by_user_id',
          'reviewed_at'
        )
      ORDER BY column_name
      `,
    );
    expect(requiredColumns.rows).toHaveLength(8);
    expect(requiredColumns.rows.every((row) => row.is_nullable === "NO")).toBe(true);

    const constraints = await tx.query<{ conname: string; definition: string }>(
      `
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'assessment_evidence_checklists'::regclass
      ORDER BY conname
      `,
    );
    const definitions = constraints.rows.map((row) => row.definition).join("\n");
    expect(definitions).toContain("YES");
    expect(definitions).toContain("NOT_APPLICABLE");
    expect(definitions).toContain("PARTIALLY");
    expect(definitions).toContain("PENDING");
    expect(definitions).toContain("STRONG");
    expect(definitions).toContain("MODERATE");
    expect(definitions).toContain("WEAK");
    expect(definitions).toContain("NONE");
    expect(definitions).toContain("UNIQUE (assessment_requirement_item_id)");
    expect(definitions).toContain("length(review_notes) <= 2000");
  });

  it("extends auth audit event check with evidence checklist event", async () => {
    const constraint = await tx.query<{ definition: string }>(
      `
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'auth_audit_logs'::regclass
        AND conname = 'chk_auth_audit_logs_event_type'
      `,
    );
    expect(constraint.rows).toHaveLength(1);
    expect(constraint.rows[0].definition).toContain("EVIDENCE_CHECKLIST_UPSERTED");
  });
});
