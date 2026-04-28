import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { PkcertDecisionRepository } from "../src/pkcert-decision/repository.js";

describe("PkcertDecisionRepository", () => {
  it("throws MISSING_TX_CONTEXT when tx is missing for mutating methods", async () => {
    const repository = new PkcertDecisionRepository({ query: vi.fn() });

    await expect(
      repository.getExternalSubmissionForDecisionUpdate(
        undefined,
        "11111111-1111-1111-1111-111111111111",
      ),
    ).rejects.toThrow("Transactional context is required");

    await expect(
      repository.insertDecision(undefined, {
        externalSubmissionId: "11111111-1111-1111-1111-111111111111",
        intakeReviewId: "22222222-2222-2222-2222-222222222222",
        orgId: "33333333-3333-3333-3333-333333333333",
        assessmentCycleId: "44444444-4444-4444-4444-444444444444",
        submissionPackageId: "55555555-5555-5555-5555-555555555555",
        decision: "ACCEPTED",
        decisionReason: "This decision reason is long enough for validation.",
        decidedByUserId: "66666666-6666-6666-6666-666666666666",
        decidedAt: new Date("2026-04-26T00:00:00.000Z"),
      }),
    ).rejects.toThrow("Transactional context is required");
  });

  it("locks external submission and intake review rows FOR UPDATE for decision creation", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const tx = { query } as unknown as PoolClient;
    const repository = new PkcertDecisionRepository({ query: vi.fn() });

    await repository.getExternalSubmissionForDecisionUpdate(
      tx,
      "11111111-1111-1111-1111-111111111111",
    );
    await repository.getIntakeForDecisionUpdate(
      tx,
      "11111111-1111-1111-1111-111111111111",
    );

    const sql = query.mock.calls.map((call) => String(call[0]).toUpperCase()).join("\n");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("FROM EXTERNAL_SUBMISSIONS");
    expect(sql).toContain("FROM PKCERT_INTAKE_REVIEWS");
  });

  it("does not expose update or delete methods for decision records", () => {
    const repository = new PkcertDecisionRepository({ query: vi.fn() });
    expect("updateDecision" in repository).toBe(false);
    expect("deleteDecision" in repository).toBe(false);
  });

  it("decision existence lookup filters by org and external submission", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ exists: true }] });
    const repository = new PkcertDecisionRepository({ query });

    await repository.decisionExistsForSubmission(
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    );

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("WHERE org_id = $1");
    expect(sql).toContain("external_submission_id = $2");
  });
});
