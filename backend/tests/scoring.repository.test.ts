import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { ScoringRepository } from "../src/scoring/repository.js";

describe("ScoringRepository", () => {
  it("throws MISSING_TX_CONTEXT when tx is missing for mutating methods", async () => {
    const repository = new ScoringRepository({ query: vi.fn() });

    await expect(
      repository.getCycleForScoringUpdate(
        undefined,
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      ),
    ).rejects.toThrow("Transactional context is required");

    await expect(
      repository.clearRequirementScores(undefined, "33333333-3333-3333-3333-333333333333"),
    ).rejects.toThrow("Transactional context is required");

    await expect(
      repository.clearControlScores(undefined, "33333333-3333-3333-3333-333333333333"),
    ).rejects.toThrow("Transactional context is required");
  });

  it("uses FOR UPDATE when locking cycle for scoring", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const tx = { query } as unknown as PoolClient;
    const repository = new ScoringRepository({ query: vi.fn() });

    await repository.getCycleForScoringUpdate(
      tx,
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    );

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql.toUpperCase()).toContain("FOR UPDATE");
  });
});
