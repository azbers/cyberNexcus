import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { ExternalSubmissionRepository } from "../src/external-submission/repository.js";

describe("ExternalSubmissionRepository", () => {
  it("throws MISSING_TX_CONTEXT when tx is missing for mutating methods", async () => {
    const repository = new ExternalSubmissionRepository({ query: vi.fn() });

    await expect(
      repository.getPackageForSubmitUpdate(
        undefined,
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      ),
    ).rejects.toThrow("Transactional context is required");

    await expect(
      repository.insertSubmission(undefined, {
        orgId: "11111111-1111-1111-1111-111111111111",
        submissionPackageId: "22222222-2222-2222-2222-222222222222",
        assessmentCycleId: "33333333-3333-3333-3333-333333333333",
        submissionNumber: "EXT-20260425-ABCDEF12",
        submittedByUserId: "44444444-4444-4444-4444-444444444444",
        submittedAt: new Date("2026-04-25T00:00:00.000Z"),
      }),
    ).rejects.toThrow("Transactional context is required");
  });

  it("uses FOR UPDATE when locking package for submit", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const tx = { query } as unknown as PoolClient;
    const repository = new ExternalSubmissionRepository({ query: vi.fn() });

    await repository.getPackageForSubmitUpdate(
      tx,
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    );

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql.toUpperCase()).toContain("FOR UPDATE");
  });

  it("uses FOR UPDATE when locking submission for withdraw", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const tx = { query } as unknown as PoolClient;
    const repository = new ExternalSubmissionRepository({ query: vi.fn() });

    await repository.getSubmissionForWithdrawUpdate(
      tx,
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    );

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql.toUpperCase()).toContain("FOR UPDATE");
  });

  it("active submission lookup filters status SUBMITTED", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const repository = new ExternalSubmissionRepository({ query });

    await repository.getActiveSubmissionByPackage(
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    );

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("status = 'SUBMITTED'");
  });

  it("withdraw update only mutates withdrawal fields", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const tx = { query } as unknown as PoolClient;
    const repository = new ExternalSubmissionRepository({ query: vi.fn() });

    await repository.withdrawSubmission(tx, {
      orgId: "11111111-1111-1111-1111-111111111111",
      submissionId: "22222222-2222-2222-2222-222222222222",
      withdrawnByUserId: "33333333-3333-3333-3333-333333333333",
      withdrawnAt: new Date("2026-04-25T00:00:00.000Z"),
      withdrawReason: "Valid withdrawal reason.",
    });

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("SET status = 'WITHDRAWN'");
    expect(sql).toContain("withdrawn_by_user_id");
    expect(sql).toContain("withdrawn_at");
    expect(sql).toContain("withdraw_reason");
    expect(sql).not.toContain("submission_package_id =");
    expect(sql).not.toContain("assessment_cycle_id =");
    expect(sql).not.toContain("submitted_by_user_id =");
    expect(sql).not.toContain("submitted_at =");
  });
});
