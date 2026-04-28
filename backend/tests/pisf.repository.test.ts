import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { PisfRepository } from "../src/pisf/repository.js";

describe("PisfRepository", () => {
  it("throws MISSING_TX_CONTEXT when tx is missing for transactional methods", async () => {
    const readExecutor = { query: vi.fn() };
    const repository = new PisfRepository(readExecutor);

    await expect(
      repository.createImportBatch(undefined, {
        sourceFileName: "controls.json",
        sourceChecksum: "a".repeat(64),
        status: "STARTED",
      }),
    ).rejects.toThrow("Transactional context is required");

    await expect(
      repository.upsertDomain(undefined, {
        domainCode: "domain_1",
        name: "Domain 1",
        description: null,
        sourceHash: "b".repeat(64),
        lastImportBatchId: "11111111-1111-1111-1111-111111111111",
      }),
    ).rejects.toThrow("Transactional context is required");
  });

  it("uses FOR UPDATE in transactional upsert lookups", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "x" }] });
    const tx = { query } as unknown as PoolClient;
    const repository = new PisfRepository({ query: vi.fn() });

    await repository.upsertDomain(tx, {
      domainCode: "domain_1",
      name: "Domain 1",
      description: null,
      sourceHash: "c".repeat(64),
      lastImportBatchId: "11111111-1111-1111-1111-111111111111",
    });

    const lookupSql = String(query.mock.calls[0]?.[0] ?? "");
    expect(lookupSql.toUpperCase()).toContain("FOR UPDATE");
  });
});
