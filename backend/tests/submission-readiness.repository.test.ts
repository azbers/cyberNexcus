import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { SubmissionReadinessRepository } from "../src/submission-readiness/repository.js";

describe("SubmissionReadinessRepository", () => {
  it("throws MISSING_TX_CONTEXT when tx is missing for mutating methods", async () => {
    const repository = new SubmissionReadinessRepository({ query: vi.fn() });

    await expect(
      repository.getCycleForUpdate(
        undefined,
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      ),
    ).rejects.toThrow("Transactional context is required");

    await expect(
      repository.upsertReadiness(undefined, {
        orgId: "11111111-1111-1111-1111-111111111111",
        assessmentCycleId: "22222222-2222-2222-2222-222222222222",
        reviewNotes: null,
        confirmedAssessmentComplete: true,
        confirmedEvidenceAttached: true,
        confirmedEvidenceReviewed: true,
        confirmedScoreReviewed: true,
        confirmedAuthorizedSubmitter: true,
        confirmedInformationAccurate: true,
        declarationText:
          "I confirm that this assessment information is accurate and internally reviewed.",
        declaredByUserId: "33333333-3333-3333-3333-333333333333",
        declaredAt: new Date("2026-04-25T00:00:00.000Z"),
      }),
    ).rejects.toThrow("Transactional context is required");
  });

  it("uses FOR UPDATE when locking cycle for mark-ready", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const tx = { query } as unknown as PoolClient;
    const repository = new SubmissionReadinessRepository({ query: vi.fn() });

    await repository.getCycleForUpdate(
      tx,
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    );

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql.toUpperCase()).toContain("FOR UPDATE");
  });
});
