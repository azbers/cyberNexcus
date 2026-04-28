import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { AssessmentService } from "../src/assessment/service.js";

const dummyTx = {} as PoolClient;

describe("AssessmentService", () => {
  it("rejects invalid assessment status values", async () => {
    const repository = {
      findActorProfile: vi.fn().mockResolvedValue({
        user_id: "u1",
        org_id: "o1",
        role: "admin",
      }),
      getCycleForUpdate: vi.fn().mockResolvedValue({
        id: "c1",
        org_id: "o1",
        status: "DRAFT",
      }),
      getItemForUpdate: vi.fn().mockResolvedValue({
        id: "i1",
        assessment_cycle_id: "c1",
        pisf_requirement_id: "r1",
        requirement_key_snapshot: "K::1",
        requirement_text_snapshot: "text",
        source_hash_snapshot: "a".repeat(64),
        assessment_status: "UNASSESSED",
      }),
      updateItemStatus: vi.fn(),
      appendAuditEvent: vi.fn(),
    } as any;

    const service = new AssessmentService({ repository });
    await expect(
      service.updateRequirementItemStatus(
        dummyTx,
        {
          userId: "u1",
          orgId: "o1",
          sessionId: "s1",
          sessionFamilyId: "f1",
          tokenVersion: 0,
          tokenKind: "access",
          iat: 1,
          exp: 2,
        },
        "c1",
        "i1",
        "INVALID_STATUS",
        { ipAddress: null, userAgent: null },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ASSESSMENT_STATUS",
      statusCode: 400,
    });
  });

  it("blocks finalize when UNASSESSED items remain", async () => {
    const repository = {
      findActorProfile: vi.fn().mockResolvedValue({
        user_id: "u1",
        org_id: "o1",
        role: "admin",
      }),
      getCycleForUpdate: vi.fn().mockResolvedValue({
        id: "c1",
        org_id: "o1",
        status: "DRAFT",
      }),
      countUnassessedItems: vi.fn().mockResolvedValue(3),
      finalizeInternalCycle: vi.fn(),
      appendAuditEvent: vi.fn(),
    } as any;

    const service = new AssessmentService({ repository });
    await expect(
      service.finalizeInternalCycle(
        dummyTx,
        {
          userId: "u1",
          orgId: "o1",
          sessionId: "s1",
          sessionFamilyId: "f1",
          tokenVersion: 0,
          tokenKind: "access",
          iat: 1,
          exp: 2,
        },
        "c1",
        { ipAddress: null, userAgent: null },
      ),
    ).rejects.toMatchObject({
      code: "ASSESSMENT_FINALIZE_BLOCKED_UNASSESSED",
      statusCode: 409,
    });
  });
});
