import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { AuthRepository } from "../src/auth/repository.js";

describe("AuthRepository", () => {
  it("throws when tx is missing", async () => {
    const repository = new AuthRepository();

    await expect(
      repository.findSessionForRefreshUpdate(undefined, "a".repeat(64)),
    ).rejects.toThrow("Transactional context is required");
  });

  it("uses SELECT FOR UPDATE in refresh lookup", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const fakeTx = { query } as unknown as PoolClient;
    const repository = new AuthRepository();

    await repository.findSessionForRefreshUpdate(fakeTx, "b".repeat(64));

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql.toUpperCase()).toContain("FOR UPDATE");
  });

  it("uses SELECT FOR UPDATE in active session lock", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const fakeTx = { query } as unknown as PoolClient;
    const repository = new AuthRepository();

    await repository.lockActiveSessionsForUser(fakeTx, "user-1");

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql.toUpperCase()).toContain("FOR UPDATE");
  });

  it("rejects invalid audit event payload before DB write", async () => {
    const query = vi.fn();
    const fakeTx = { query } as unknown as PoolClient;
    const repository = new AuthRepository();

    await expect(
      repository.appendAuditEvent(fakeTx, {
        eventType: "NOT_ALLOWED" as never,
        severity: "INFO",
        userId: "u",
        orgId: "o",
        sessionId: null,
        ipAddress: null,
        userAgent: null,
        metadata: {},
      }),
    ).rejects.toThrow("Invalid audit event payload");
    expect(query).not.toHaveBeenCalled();
  });
});
