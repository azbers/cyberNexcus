import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { OrganizationRepository } from "../src/org/repository.js";

describe("OrganizationRepository", () => {
  it("throws MISSING_TX_CONTEXT for transactional methods when tx is missing", async () => {
    const repository = new OrganizationRepository();

    await expect(repository.getOrganizationForUpdate(undefined, "org-1")).rejects.toThrow(
      "Transactional context is required",
    );
    await expect(
      repository.updateOrganizationLifecycle(undefined, {
        orgId: "org-1",
        status: "APPROVED",
        rejectionReason: null,
        suspendedAt: null,
        deactivatedAt: null,
      }),
    ).rejects.toThrow("Transactional context is required");
    await expect(
      repository.listPendingOrganizations(undefined, {
        limit: 25,
        offset: 0,
      }),
    ).rejects.toThrow("Transactional context is required");
    await expect(
      repository.appendAuditEvent(undefined, {
        eventType: "ORG_APPROVED",
        severity: "INFO",
        userId: "user-1",
        orgId: "org-1",
        ipAddress: null,
        userAgent: null,
        metadata: {},
      }),
    ).rejects.toThrow("Transactional context is required");
  });

  it("uses SELECT FOR UPDATE in getOrganizationForUpdate", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const tx = { query } as unknown as PoolClient;
    const repository = new OrganizationRepository();

    await repository.getOrganizationForUpdate(tx, "org-1");

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql.toUpperCase()).toContain("FOR UPDATE");
  });
});
