import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { CorrectionResubmissionRepository } from "../src/correction-resubmission/repository.js";

describe("CorrectionResubmissionRepository", () => {
  it("throws MISSING_TX_CONTEXT when tx is missing for mutating methods", async () => {
    const repository = new CorrectionResubmissionRepository({ query: vi.fn() });

    await expect(
      repository.insertCorrection(undefined, {
        orgId: "11111111-1111-1111-1111-111111111111",
        originalExternalSubmissionId: "22222222-2222-2222-2222-222222222222",
        originalDecisionId: "33333333-3333-3333-3333-333333333333",
        originalSubmissionPackageId: "44444444-4444-4444-4444-444444444444",
        originalAssessmentCycleId: "55555555-5555-5555-5555-555555555555",
        correctionReason: "Correction reason is long enough for validation.",
        createdByUserId: "66666666-6666-6666-6666-666666666666",
      }),
    ).rejects.toThrow("Transactional context is required");

    await expect(
      repository.getCorrectionForUpdate(
        undefined,
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      ),
    ).rejects.toThrow("Transactional context is required");

    await expect(
      repository.updateSummary(undefined, {
        orgId: "11111111-1111-1111-1111-111111111111",
        correctionId: "22222222-2222-2222-2222-222222222222",
        correctionSummary: "Updated summary is long enough.",
      }),
    ).rejects.toThrow("Transactional context is required");
  });

  it("locks correction rows FOR UPDATE for lifecycle mutations", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const tx = { query } as unknown as PoolClient;
    const repository = new CorrectionResubmissionRepository({ query: vi.fn() });

    await repository.getCorrectionForUpdate(
      tx,
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    );

    const sql = String(query.mock.calls[0]?.[0] ?? "").toUpperCase();
    expect(sql).toContain("FROM CORRECTION_RESUBMISSIONS");
    expect(sql).toContain("FOR UPDATE");
  });

  it("active correction lookup filters DRAFT and READY_FOR_RESUBMISSION", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ exists: true }] });
    const repository = new CorrectionResubmissionRepository({ query });

    await repository.activeCorrectionExistsForDecision(
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    );

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("original_decision_id = $2");
    expect(sql).toContain("status IN ('DRAFT', 'READY_FOR_RESUBMISSION')");
  });

  it("does not expose physical delete methods", () => {
    const repository = new CorrectionResubmissionRepository({ query: vi.fn() });
    expect("deleteCorrection" in repository).toBe(false);
    expect("delete" in repository).toBe(false);
  });
});
