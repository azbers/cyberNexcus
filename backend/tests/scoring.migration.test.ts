import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

import { createPool } from "../src/db/pool.js";
import {
  beginIsolatedTestTransaction,
  DEFAULT_TEST_DATABASE_URL,
  rollbackAndRelease,
} from "./test-db.js";

describe("Scoring migrations", () => {
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

  it("creates scoring tables with required unique constraints", async () => {
    const tables = await tx.query<{ name: string }>(
      `
      SELECT unnest(ARRAY[
        to_regclass('public.assessment_score_snapshots')::text,
        to_regclass('public.assessment_requirement_scores')::text,
        to_regclass('public.assessment_control_scores')::text
      ]) AS name
      `,
    );

    expect(tables.rows.map((row) => row.name)).toEqual([
      "assessment_score_snapshots",
      "assessment_requirement_scores",
      "assessment_control_scores",
    ]);

    const constraints = await tx.query<{ conname: string; definition: string }>(
      `
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid IN (
        'assessment_score_snapshots'::regclass,
        'assessment_requirement_scores'::regclass,
        'assessment_control_scores'::regclass
      )
      ORDER BY conname
      `,
    );
    const definitions = constraints.rows.map((row) => row.definition).join("\n");

    expect(definitions).toContain("UNIQUE (assessment_cycle_id)");
    expect(definitions).toContain("UNIQUE (score_snapshot_id, assessment_requirement_item_id)");
    expect(definitions).toContain("UNIQUE (score_snapshot_id, pisf_control_id)");
    expect(definitions).toContain("NON_COMPLIANT");
    expect(definitions).toContain("SUBSTANTIALLY_COMPLIANT");
  });

  it("uses non-cascade foreign keys for scoring tables", async () => {
    const fks = await tx.query<{ conname: string; confdeltype: string; definition: string }>(
      `
      SELECT conname, confdeltype, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid IN (
        'assessment_score_snapshots'::regclass,
        'assessment_requirement_scores'::regclass,
        'assessment_control_scores'::regclass
      )
        AND contype = 'f'
      ORDER BY conname
      `,
    );

    expect(fks.rows.length).toBeGreaterThan(0);
    expect(fks.rows.every((row) => row.confdeltype !== "c")).toBe(true);
  });

  it("extends auth audit event check with scoring calculation event", async () => {
    const constraint = await tx.query<{ definition: string }>(
      `
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'auth_audit_logs'::regclass
        AND conname = 'chk_auth_audit_logs_event_type'
      `,
    );

    expect(constraint.rows).toHaveLength(1);
    expect(constraint.rows[0].definition).toContain("ASSESSMENT_SCORE_CALCULATED");
  });
});
