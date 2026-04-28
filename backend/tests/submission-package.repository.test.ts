import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { SubmissionPackageRepository } from "../src/submission-package/repository.js";
import {
  canonicalJson,
  manifestHashFor,
} from "../src/submission-package/service.js";

describe("SubmissionPackageRepository", () => {
  it("throws MISSING_TX_CONTEXT when tx is missing for mutating methods", async () => {
    const repository = new SubmissionPackageRepository({ query: vi.fn() });

    await expect(
      repository.getCycleForPackageUpdate(
        undefined,
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      ),
    ).rejects.toThrow("Transactional context is required");

    await expect(
      repository.insertPackage(undefined, {
        orgId: "11111111-1111-1111-1111-111111111111",
        assessmentCycleId: "22222222-2222-2222-2222-222222222222",
        scoreSnapshotId: "33333333-3333-3333-3333-333333333333",
        readinessId: "44444444-4444-4444-4444-444444444444",
        packageNumber: "SUB-20260425-ABCDEF12",
        manifestJson: { packageVersion: "SUBMISSION_PACKAGE_V1" },
        manifestHash: "a".repeat(64),
        createdByUserId: "55555555-5555-5555-5555-555555555555",
        createdAt: new Date("2026-04-25T00:00:00.000Z"),
      }),
    ).rejects.toThrow("Transactional context is required");
  });

  it("uses FOR UPDATE when locking cycle for package creation", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const tx = { query } as unknown as PoolClient;
    const repository = new SubmissionPackageRepository({ query: vi.fn() });

    await repository.getCycleForPackageUpdate(
      tx,
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    );

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql.toUpperCase()).toContain("FOR UPDATE");
  });

  it("active package lookup filters status CREATED", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const repository = new SubmissionPackageRepository({ query });

    await repository.getActivePackageByCycle(
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    );

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("status = 'CREATED'");
  });

  it("canonical manifest hashing is stable across object key order", () => {
    const a = {
      z: "last",
      a: {
        y: 2,
        x: 1,
      },
      list: [{ b: 2, a: 1 }],
    };
    const b = {
      list: [{ a: 1, b: 2 }],
      a: {
        x: 1,
        y: 2,
      },
      z: "last",
    };

    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(manifestHashFor(a)).toBe(manifestHashFor(b));
    expect(manifestHashFor(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});
