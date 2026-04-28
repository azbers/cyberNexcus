import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { EvidenceRepository } from "../src/evidence/repository.js";

describe("EvidenceRepository", () => {
  it("throws MISSING_TX_CONTEXT when tx is missing for mutating methods", async () => {
    const repository = new EvidenceRepository({ query: vi.fn() });

    await expect(
      repository.countActiveEvidenceForItem(undefined, "item-id"),
    ).rejects.toThrow("Transactional context is required");

    await expect(
      repository.insertEvidenceFile(undefined, {
        orgId: "11111111-1111-1111-1111-111111111111",
        assessmentCycleId: "22222222-2222-2222-2222-222222222222",
        assessmentRequirementItemId: "33333333-3333-3333-3333-333333333333",
        uploadedByUserId: "44444444-4444-4444-4444-444444444444",
        originalFilename: "evidence.txt",
        storedFilename: "stored",
        storageKey: "key",
        storageBackend: "LOCAL",
        mimeTypeClaimed: "text/plain",
        mimeTypeDetected: "text/plain",
        fileExtension: "txt",
        fileSizeBytes: 10,
        sha256Hash: "a".repeat(64),
        validationResultJson: {
          extension_allowed: true,
          mime_detected: "text/plain",
          size_allowed: true,
          sha256: "a".repeat(64),
          malware_scan: "NOT_PERFORMED",
        },
      }),
    ).rejects.toThrow("Transactional context is required");
  });

  it("uses FOR UPDATE in lock queries", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const tx = { query } as unknown as PoolClient;
    const repository = new EvidenceRepository({ query: vi.fn() });

    await repository.getCycleItemTupleForUpdate(
      tx,
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
      "33333333-3333-3333-3333-333333333333",
    );
    await repository.getEvidenceForUpdate(
      tx,
      "11111111-1111-1111-1111-111111111111",
      "44444444-4444-4444-4444-444444444444",
    );

    const firstSql = String(query.mock.calls[0]?.[0] ?? "");
    const secondSql = String(query.mock.calls[1]?.[0] ?? "");
    expect(firstSql.toUpperCase()).toContain("FOR UPDATE");
    expect(secondSql.toUpperCase()).toContain("FOR UPDATE");
  });
});
