import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import { createPool } from "../src/db/pool.js";
import { PisfRepository } from "../src/pisf/repository.js";
import { PisfService, type SourceControlRow } from "../src/pisf/service.js";
import {
  beginIsolatedTestTransaction,
  DEFAULT_TEST_DATABASE_URL,
  rollbackAndRelease,
} from "./test-db.js";

function checksum(rows: SourceControlRow[]): string {
  return createHash("sha256").update(JSON.stringify(rows), "utf8").digest("hex");
}

describe("PISF import", () => {
  let pool: Pool;
  let tx: PoolClient;
  let repository: PisfRepository;
  let service: PisfService;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL);
  });

  beforeEach(async () => {
    tx = await beginIsolatedTestTransaction(pool);
    repository = new PisfRepository(pool);
    service = new PisfService(repository);
  });

  afterEach(async () => {
    await rollbackAndRelease(tx);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("migration created all Phase 4 PISF tables", async () => {
    const tables = await tx.query<{ name: string }>(
      `
      SELECT unnest(ARRAY[
        to_regclass('public.pisf_domains')::text,
        to_regclass('public.pisf_controls')::text,
        to_regclass('public.pisf_requirements')::text,
        to_regclass('public.pisf_import_batches')::text,
        to_regclass('public.pisf_import_review_items')::text
      ]) AS name
      `,
    );
    expect(tables.rows.map((row) => row.name)).toEqual([
      "pisf_domains",
      "pisf_controls",
      "pisf_requirements",
      "pisf_import_batches",
      "pisf_import_review_items",
    ]);
  });

  it("imports initial dataset and uses requirement_key = control_code::ordinal", async () => {
    const code = `TST-${randomUUID().slice(0, 8)}`;
    const rows: SourceControlRow[] = [
      {
        domain: "Domain 9901",
        controlCode: code,
        phase: "Phase 1",
        area: "Test Area",
        subArea: "Test Sub Area",
        title: "Test Control",
        statement: "1. First atomic obligation.\n2. Second atomic obligation.",
      },
    ];

    const result = await service.importFromRows(tx, {
      sourceFileName: "test-controls.json",
      sourceChecksum: checksum(rows),
      force: false,
      rows,
    });

    expect(result.status).toBe("COMPLETED");
    const requirements = await tx.query<{
      requirement_key: string;
      ordinal: number;
      derivation_method: string;
      status: string;
    }>(
      `
      SELECT requirement_key, ordinal, derivation_method, status
      FROM pisf_requirements
      WHERE requirement_key LIKE $1
      ORDER BY ordinal ASC
      `,
      [`${code}::%`],
    );

    expect(requirements.rows).toHaveLength(2);
    expect(requirements.rows[0].requirement_key).toBe(`${code}::1`);
    expect(requirements.rows[1].requirement_key).toBe(`${code}::2`);
    expect(requirements.rows.every((row) => row.derivation_method === "deterministic_split")).toBe(
      true,
    );
    expect(requirements.rows.every((row) => row.status === "ACTIVE")).toBe(true);
  });

  it("is idempotent, skips same checksum unless force", async () => {
    const code = `TST-${randomUUID().slice(0, 8)}`;
    const rows: SourceControlRow[] = [
      {
        domain: "Domain 9902",
        controlCode: code,
        phase: "Phase 1",
        area: "Test Area",
        subArea: "Sub Area",
        title: "Control",
        statement: "Single obligation statement.",
      },
    ];
    const sourceChecksum = checksum(rows);

    const first = await service.importFromRows(tx, {
      sourceFileName: "test-controls.json",
      sourceChecksum,
      force: false,
      rows,
    });
    expect(first.status).toBe("COMPLETED");

    const second = await service.importFromRows(tx, {
      sourceFileName: "test-controls.json",
      sourceChecksum,
      force: false,
      rows,
    });
    expect(second.status).toBe("SKIPPED");

    const forced = await service.importFromRows(tx, {
      sourceFileName: "test-controls.json",
      sourceChecksum,
      force: true,
      rows,
    });
    expect(forced.status).toBe("COMPLETED");
  });

  it("soft deactivates controls and requirements missing from source", async () => {
    const code1 = `TST-${randomUUID().slice(0, 8)}-A`;
    const code2 = `TST-${randomUUID().slice(0, 8)}-B`;
    const rows1: SourceControlRow[] = [
      {
        domain: "Domain 9903",
        controlCode: code1,
        phase: "Phase 1",
        area: "Area",
        subArea: "Sub Area",
        title: "Control A",
        statement: "Single statement A.",
      },
      {
        domain: "Domain 9903",
        controlCode: code2,
        phase: "Phase 1",
        area: "Area",
        subArea: "Sub Area",
        title: "Control B",
        statement: "Single statement B.",
      },
    ];
    await service.importFromRows(tx, {
      sourceFileName: "test-controls.json",
      sourceChecksum: checksum(rows1),
      force: true,
      rows: rows1,
    });

    const rows2 = rows1.slice(0, 1);
    const second = await service.importFromRows(tx, {
      sourceFileName: "test-controls.json",
      sourceChecksum: checksum(rows2),
      force: true,
      rows: rows2,
    });

    expect(second.summary.deactivated).toBeGreaterThan(0);

    const missingControl = await tx.query<{ is_active: boolean; deprecated_at: Date | null }>(
      `
      SELECT is_active, deprecated_at
      FROM pisf_controls
      WHERE control_code = $1
      `,
      [code2],
    );
    expect(missingControl.rows[0].is_active).toBe(false);
    expect(missingControl.rows[0].deprecated_at).not.toBeNull();

    const missingRequirement = await tx.query<{
      is_active: boolean;
      status: string;
      deprecated_at: Date | null;
    }>(
      `
      SELECT is_active, status, deprecated_at
      FROM pisf_requirements
      WHERE requirement_key = $1
      `,
      [`${code2}::1`],
    );
    expect(missingRequirement.rows[0].is_active).toBe(false);
    expect(missingRequirement.rows[0].status).toBe("DEPRECATED");
    expect(missingRequirement.rows[0].deprecated_at).not.toBeNull();
  });

  it("marks ambiguous derivation as NEEDS_REVIEW and writes review item", async () => {
    const code = `TST-${randomUUID().slice(0, 8)}-AMB`;
    const rows: SourceControlRow[] = [
      {
        domain: "Domain 9904",
        controlCode: code,
        phase: "Phase 2",
        area: "Area",
        subArea: "Sub Area",
        title: "Ambiguous",
        statement: "Must do A on first line.\nAnd also do B on second line.",
      },
    ];

    const result = await service.importFromRows(tx, {
      sourceFileName: "test-controls.json",
      sourceChecksum: checksum(rows),
      force: true,
      rows,
    });

    expect(result.summary.needs_review).toBeGreaterThan(0);

    const requirement = await tx.query<{
      status: string;
      derivation_method: string;
      source_control_text: string;
      source_fragment: string | null;
    }>(
      `
      SELECT status, derivation_method, source_control_text, source_fragment
      FROM pisf_requirements
      WHERE requirement_key = $1
      `,
      [`${code}::1`],
    );
    expect(requirement.rows[0].status).toBe("NEEDS_REVIEW");
    expect(requirement.rows[0].derivation_method).toBe("manual_review_required");
    expect(requirement.rows[0].source_fragment).toBeNull();
    expect(requirement.rows[0].source_control_text).toContain("Must do A");

    const review = await tx.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM pisf_import_review_items
      WHERE source_control_code = $1
      `,
      [code],
    );
    expect(Number(review.rows[0].count)).toBeGreaterThanOrEqual(1);
  });
});
