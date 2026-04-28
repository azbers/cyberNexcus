import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { CorrectionExecutionRepository } from "../src/correction-execution/repository.js";

describe("CorrectionExecutionRepository", () => {
  it("throws MISSING_TX_CONTEXT when tx is missing for mutating methods", async () => {
    const repository = new CorrectionExecutionRepository({ query: vi.fn() });

    await expect(
      repository.getCorrectionForUpdate(
        undefined,
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      ),
    ).rejects.toThrow("Transactional context is required");

    await expect(
      repository.insertExecution(undefined, {
        orgId: "11111111-1111-1111-1111-111111111111",
        correctionResubmissionId: "22222222-2222-2222-2222-222222222222",
        originalAssessmentCycleId: "33333333-3333-3333-3333-333333333333",
        correctionAssessmentCycleId: "44444444-4444-4444-4444-444444444444",
        createdByUserId: "55555555-5555-5555-5555-555555555555",
      }),
    ).rejects.toThrow("Transactional context is required");

    await expect(
      repository.voidExecution(undefined, {
        orgId: "11111111-1111-1111-1111-111111111111",
        executionId: "22222222-2222-2222-2222-222222222222",
        voidedByUserId: "33333333-3333-3333-3333-333333333333",
        voidedAt: new Date(),
        voidReason: "Valid void reason.",
      }),
    ).rejects.toThrow("Transactional context is required");
  });

  it("locks correction and execution rows FOR UPDATE", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const tx = { query } as unknown as PoolClient;
    const repository = new CorrectionExecutionRepository({ query: vi.fn() });

    await repository.getCorrectionForUpdate(
      tx,
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    );
    await repository.getExecutionForUpdate(
      tx,
      "11111111-1111-1111-1111-111111111111",
      "33333333-3333-3333-3333-333333333333",
    );

    const correctionSql = String(query.mock.calls[0]?.[0] ?? "").toUpperCase();
    const executionSql = String(query.mock.calls[1]?.[0] ?? "").toUpperCase();
    expect(correctionSql).toContain("FROM CORRECTION_RESUBMISSIONS");
    expect(correctionSql).toContain("FOR UPDATE");
    expect(executionSql).toContain("FROM CORRECTION_EXECUTION_CYCLES");
    expect(executionSql).toContain("FOR UPDATE");
  });

  it("active execution lookup filters CREATED only", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ exists: true }] });
    const tx = { query } as unknown as PoolClient;
    const repository = new CorrectionExecutionRepository({ query: vi.fn() });

    await repository.activeExecutionExistsForCorrection(
      tx,
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    );

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("correction_resubmission_id = $2");
    expect(sql).toContain("status = 'CREATED'");
  });

  it("clone query resets statuses to UNASSESSED and nulls updated_by_user_id", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 2 });
    const tx = { query } as unknown as PoolClient;
    const repository = new CorrectionExecutionRepository({ query: vi.fn() });

    await repository.cloneRequirementItems(
      tx,
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    );

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("INSERT INTO assessment_requirement_items");
    expect(sql).toContain("'UNASSESSED'");
    expect(sql).toContain("NULL");
  });

  it("does not expose physical delete methods", () => {
    const repository = new CorrectionExecutionRepository({ query: vi.fn() });
    expect("deleteExecution" in repository).toBe(false);
    expect("delete" in repository).toBe(false);
  });
});
