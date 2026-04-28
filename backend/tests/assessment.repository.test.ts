import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { AssessmentRepository } from "../src/assessment/repository.js";

describe("AssessmentRepository", () => {
  it("throws MISSING_TX_CONTEXT when tx is missing for mutating methods", async () => {
    const repository = new AssessmentRepository({ query: vi.fn() });

    await expect(
      repository.createDraftCycle(undefined, {
        orgId: "11111111-1111-1111-1111-111111111111",
        createdByUserId: "22222222-2222-2222-2222-222222222222",
      }),
    ).rejects.toThrow("Transactional context is required");

    await expect(
      repository.updateItemStatus(undefined, {
        itemId: "33333333-3333-3333-3333-333333333333",
        status: "FULLY_COMPLIANT",
        updatedByUserId: "22222222-2222-2222-2222-222222222222",
      }),
    ).rejects.toThrow("Transactional context is required");

    await expect(
      repository.upsertEvidenceChecklist(undefined, {
        orgId: "11111111-1111-1111-1111-111111111111",
        assessmentCycleId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        assessmentRequirementItemId: "33333333-3333-3333-3333-333333333333",
        datedWithin12Months: "YES",
        organizationSpecific: "YES",
        addressesRequirement: "YES",
        approvedByAuthority: "YES",
        currentlyInForce: "YES",
        evidenceQuality: "STRONG",
        reviewNotes: null,
        reviewedByUserId: "22222222-2222-2222-2222-222222222222",
        reviewedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow("Transactional context is required");
  });

  it("uses FOR UPDATE in cycle lock query", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const tx = { query } as unknown as PoolClient;
    const repository = new AssessmentRepository({ query: vi.fn() });

    await repository.getCycleForUpdate(
      tx,
      "11111111-1111-1111-1111-111111111111",
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql.toUpperCase()).toContain("FOR UPDATE");
  });
});
