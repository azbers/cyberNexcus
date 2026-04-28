import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { PkcertIntakeRepository } from "../src/pkcert-intake/repository.js";

describe("PkcertIntakeRepository", () => {
  it("throws MISSING_TX_CONTEXT when tx is missing for mutating methods", async () => {
    const repository = new PkcertIntakeRepository({ query: vi.fn() });

    await expect(
      repository.createIntakeReview(undefined, {
        externalSubmissionId: "11111111-1111-1111-1111-111111111111",
        orgId: "22222222-2222-2222-2222-222222222222",
        assessmentCycleId: "33333333-3333-3333-3333-333333333333",
        submissionPackageId: "44444444-4444-4444-4444-444444444444",
      }),
    ).rejects.toThrow("Transactional context is required");

    await expect(
      repository.getIntakeForUpdate(
        undefined,
        "11111111-1111-1111-1111-111111111111",
      ),
    ).rejects.toThrow("Transactional context is required");
  });

  it("locks intake review rows FOR UPDATE for lifecycle mutations", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const tx = { query } as unknown as PoolClient;
    const repository = new PkcertIntakeRepository({ query: vi.fn() });

    await repository.getIntakeForUpdate(
      tx,
      "11111111-1111-1111-1111-111111111111",
    );

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql.toUpperCase()).toContain("FOR UPDATE");
  });

  it("lifecycle update methods only update mutable lifecycle fields", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const tx = { query } as unknown as PoolClient;
    const repository = new PkcertIntakeRepository({ query: vi.fn() });

    await repository.assignReviewer(tx, {
      intakeReviewId: "11111111-1111-1111-1111-111111111111",
      reviewerUserId: "22222222-2222-2222-2222-222222222222",
      assignedAt: new Date("2026-04-25T00:00:00.000Z"),
    });
    await repository.startReview(tx, {
      intakeReviewId: "11111111-1111-1111-1111-111111111111",
      actorUserId: "22222222-2222-2222-2222-222222222222",
      startedAt: new Date("2026-04-25T00:00:00.000Z"),
      assignToActorIfUnassigned: true,
    });
    await repository.markReviewed(tx, {
      intakeReviewId: "11111111-1111-1111-1111-111111111111",
      actorUserId: "22222222-2222-2222-2222-222222222222",
      reviewedAt: new Date("2026-04-25T00:00:00.000Z"),
    });
    await repository.updateNotes(tx, {
      intakeReviewId: "11111111-1111-1111-1111-111111111111",
      internalNotes: "PKCERT-only notes.",
    });

    const sql = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sql).toContain("assigned_to_user_id");
    expect(sql).toContain("started_by_user_id");
    expect(sql).toContain("reviewed_by_user_id");
    expect(sql).toContain("internal_notes");
    expect(sql).not.toContain("SET external_submission_id");
    expect(sql).not.toContain("SET org_id");
    expect(sql).not.toContain("SET assessment_cycle_id");
    expect(sql).not.toContain("SET submission_package_id");
    expect(sql).not.toContain("SET created_at");
  });

  it("queue list supports status and assigned-to-me filters", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const repository = new PkcertIntakeRepository({ query });

    await repository.listIntakeReviews({
      status: "PENDING_INTAKE",
      assignedToUserId: "11111111-1111-1111-1111-111111111111",
      limit: 25,
      offset: 0,
    });

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("($1::text IS NULL OR pir.status = $1)");
    expect(sql).toContain("($2::uuid IS NULL OR pir.assigned_to_user_id = $2)");
  });
});
