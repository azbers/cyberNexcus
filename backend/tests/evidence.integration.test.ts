import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool, type PoolClient } from "pg";

import { createAuthApp } from "../src/auth/app.js";
import { AuthRepository } from "../src/auth/repository.js";
import { AuthService } from "../src/auth/service.js";
import { createPool } from "../src/db/pool.js";
import { LocalEvidenceStorage } from "../src/evidence/storage.js";
import {
  beginIsolatedTestTransaction,
  DEFAULT_TEST_DATABASE_URL,
  rollbackAndRelease,
  seedApprovedUser,
} from "./test-db.js";

const TEST_JWT_SECRET = "test-jwt-secret";

type LoginResult = {
  accessToken: string;
  userId: string;
  orgId: string;
  email: string;
  password: string;
};

describe("Evidence integration", () => {
  let pool: Pool;
  let tx: PoolClient;
  let app: ReturnType<typeof createAuthApp>;
  let storageRoot: string;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL);
  });

  beforeEach(async () => {
    tx = await beginIsolatedTestTransaction(pool);
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "pisf-evidence-test-"));
    const repository = new AuthRepository();
    const service = new AuthService({
      repository,
      jwtSecret: TEST_JWT_SECRET,
    });
    const evidenceStorage = new LocalEvidenceStorage(storageRoot);
    app = createAuthApp({
      pool,
      repository,
      service,
      jwtSecret: TEST_JWT_SECRET,
      txOverride: tx,
      evidenceStorage,
    });
  });

  afterEach(async () => {
    await rollbackAndRelease(tx);
    await rm(storageRoot, { recursive: true, force: true });
  });

  afterAll(async () => {
    await pool.end();
  });

  async function loginAs(
    role:
      | "admin"
      | "viewer"
      | "auditor"
      | "commenter"
      | "responsible_officer"
      | "it_security_lead",
  ): Promise<LoginResult> {
    const seeded = await seedApprovedUser(tx, { role });
    const login = await request(app).post("/auth/login").send({
      orgId: seeded.orgId,
      email: seeded.email,
      password: seeded.password,
    });
    expect(login.status).toBe(200);
    return {
      accessToken: String(login.body.accessToken),
      userId: seeded.userId,
      orgId: seeded.orgId,
      email: seeded.email,
      password: seeded.password,
    };
  }

  async function createUserInOrg(
    orgId: string,
    role:
      | "viewer"
      | "auditor"
      | "commenter"
      | "responsible_officer"
      | "it_security_lead"
      | "admin",
  ): Promise<LoginResult> {
    const email = `${role}-${randomUUID()}@example.com`;
    const password = "Password!234";
    const hash = await bcrypt.hash(password, 12);

    const user = await tx.query<{ id: string }>(
      `
      INSERT INTO users (org_id, email, password_hash, role, email_verified)
      VALUES ($1, $2, $3, $4, TRUE)
      RETURNING id
      `,
      [orgId, email, hash, role],
    );
    await tx.query(
      `
      INSERT INTO password_history (user_id, password_hash)
      VALUES ($1, $2)
      `,
      [user.rows[0].id, hash],
    );

    const login = await request(app).post("/auth/login").send({
      orgId,
      email,
      password,
    });
    expect(login.status).toBe(200);
    return {
      accessToken: String(login.body.accessToken),
      userId: user.rows[0].id,
      orgId,
      email,
      password,
    };
  }

  async function createDraft(accessToken: string): Promise<string> {
    const response = await request(app)
      .post("/assessments/cycles")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({});
    expect(response.status).toBe(201);
    return String(response.body.cycle.id);
  }

  async function firstItemId(cycleId: string): Promise<string> {
    const row = await tx.query<{ id: string }>(
      `
      SELECT id
      FROM assessment_requirement_items
      WHERE assessment_cycle_id = $1
      ORDER BY requirement_key_snapshot ASC
      LIMIT 1
      `,
      [cycleId],
    );
    return row.rows[0].id;
  }

  async function seedChecklistForRequiredItems(
    cycleId: string,
    reviewedByUserId: string,
  ): Promise<void> {
    await tx.query(
      `
      INSERT INTO assessment_evidence_checklists (
        org_id,
        assessment_cycle_id,
        assessment_requirement_item_id,
        dated_within_12_months,
        organization_specific,
        addresses_requirement,
        approved_by_authority,
        currently_in_force,
        evidence_quality,
        review_notes,
        reviewed_by_user_id,
        reviewed_at
      )
      SELECT
        c.org_id,
        c.id,
        i.id,
        'YES',
        'YES',
        'YES',
        'YES',
        'YES',
        'STRONG',
        'Seeded checklist for evidence lifecycle regression.',
        $2,
        now()
      FROM assessment_requirement_items i
      JOIN assessment_cycles c ON c.id = i.assessment_cycle_id
      WHERE c.id = $1
        AND i.assessment_status != 'NOT_APPLICABLE'
      ON CONFLICT (assessment_requirement_item_id) DO NOTHING
      `,
      [cycleId, reviewedByUserId],
    );
  }

  async function uploadEvidence(
    accessToken: string,
    cycleId: string,
    itemId: string,
    fileName = "evidence.txt",
    content = Buffer.from("security evidence text", "utf8"),
    contentType = "text/plain",
  ) {
    return request(app)
      .post(`/assessments/cycles/${cycleId}/items/${itemId}/evidence`)
      .set("Authorization", `Bearer ${accessToken}`)
      .attach("file", content, {
        filename: fileName,
        contentType,
      });
  }

  it("enforces upload role permissions", async () => {
    const admin = await loginAs("admin");
    const officer = await createUserInOrg(admin.orgId, "responsible_officer");
    const itLead = await createUserInOrg(admin.orgId, "it_security_lead");
    const viewer = await createUserInOrg(admin.orgId, "viewer");
    const commenter = await createUserInOrg(admin.orgId, "commenter");
    const auditor = await createUserInOrg(admin.orgId, "auditor");

    const cycleId = await createDraft(admin.accessToken);
    const itemId = await firstItemId(cycleId);

    const adminUpload = await uploadEvidence(admin.accessToken, cycleId, itemId);
    expect(adminUpload.status).toBe(201);

    const officerUpload = await uploadEvidence(officer.accessToken, cycleId, itemId);
    expect(officerUpload.status).toBe(201);

    const itLeadUpload = await uploadEvidence(itLead.accessToken, cycleId, itemId);
    expect(itLeadUpload.status).toBe(201);

    const viewerUpload = await uploadEvidence(viewer.accessToken, cycleId, itemId);
    expect(viewerUpload.status).toBe(403);
    expect(viewerUpload.body.code).toBe("FORBIDDEN_ACTION");

    const commenterUpload = await uploadEvidence(commenter.accessToken, cycleId, itemId);
    expect(commenterUpload.status).toBe(403);
    expect(commenterUpload.body.code).toBe("FORBIDDEN_ACTION");

    const auditorUpload = await uploadEvidence(auditor.accessToken, cycleId, itemId);
    expect(auditorUpload.status).toBe(403);
    expect(auditorUpload.body.code).toBe("FORBIDDEN_ACTION");
  });

  it("enforces same-org access for list and download", async () => {
    const admin = await loginAs("admin");
    const viewer = await createUserInOrg(admin.orgId, "viewer");
    const otherOrgAdmin = await loginAs("admin");
    const cycleId = await createDraft(admin.accessToken);
    const itemId = await firstItemId(cycleId);

    const uploaded = await uploadEvidence(admin.accessToken, cycleId, itemId);
    expect(uploaded.status).toBe(201);
    const evidenceId = String(uploaded.body.evidence.id);

    const listViewer = await request(app)
      .get(`/assessments/cycles/${cycleId}/items/${itemId}/evidence`)
      .set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(listViewer.status).toBe(200);
    expect(listViewer.body.items.length).toBeGreaterThanOrEqual(1);

    const downloadViewer = await request(app)
      .get(`/evidence/${evidenceId}/download`)
      .set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(downloadViewer.status).toBe(200);

    const listOtherOrg = await request(app)
      .get(`/assessments/cycles/${cycleId}/items/${itemId}/evidence`)
      .set("Authorization", `Bearer ${otherOrgAdmin.accessToken}`);
    expect(listOtherOrg.status).toBe(404);

    const downloadOtherOrg = await request(app)
      .get(`/evidence/${evidenceId}/download`)
      .set("Authorization", `Bearer ${otherOrgAdmin.accessToken}`);
    expect(downloadOtherOrg.status).toBe(404);
  });

  it("enforces file type allowlist and max file size", async () => {
    const admin = await loginAs("admin");
    const cycleId = await createDraft(admin.accessToken);
    const itemId = await firstItemId(cycleId);

    const invalidType = await uploadEvidence(
      admin.accessToken,
      cycleId,
      itemId,
      "payload.exe",
      Buffer.from("MZbad", "utf8"),
      "application/x-msdownload",
    );
    expect(invalidType.status).toBe(400);
    expect(invalidType.body.code).toBe("EVIDENCE_FILE_TYPE_NOT_ALLOWED");

    const tooLarge = await uploadEvidence(
      admin.accessToken,
      cycleId,
      itemId,
      "large.txt",
      Buffer.alloc(25 * 1024 * 1024 + 1, 1),
      "text/plain",
    );
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body.code).toBe("EVIDENCE_FILE_TOO_LARGE");
  });

  it("enforces max 10 active evidence files per item", async () => {
    const admin = await loginAs("admin");
    const cycleId = await createDraft(admin.accessToken);
    const itemId = await firstItemId(cycleId);

    for (let i = 0; i < 10; i += 1) {
      const up = await uploadEvidence(
        admin.accessToken,
        cycleId,
        itemId,
        `ev-${i}.txt`,
        Buffer.from(`evidence-${i}`, "utf8"),
      );
      expect(up.status).toBe(201);
    }

    const overflow = await uploadEvidence(
      admin.accessToken,
      cycleId,
      itemId,
      "overflow.txt",
      Buffer.from("overflow", "utf8"),
    );
    expect(overflow.status).toBe(409);
    expect(overflow.body.code).toBe("EVIDENCE_MAX_FILES_REACHED");
  });

  it("stores sha256 hash and never uses original filename as stored filename", async () => {
    const admin = await loginAs("admin");
    const cycleId = await createDraft(admin.accessToken);
    const itemId = await firstItemId(cycleId);
    const content = Buffer.from("integrity-check-content", "utf8");

    const uploaded = await uploadEvidence(
      admin.accessToken,
      cycleId,
      itemId,
      "proof.csv",
      content,
      "text/csv",
    );
    expect(uploaded.status).toBe(201);
    const evidenceId = String(uploaded.body.evidence.id);

    const row = await tx.query<{
      original_filename: string;
      stored_filename: string;
      storage_key: string;
      storage_backend: string;
      sha256_hash: string;
      validation_result_json: {
        extension_allowed?: boolean;
        mime_detected?: string;
        size_allowed?: boolean;
        sha256?: string;
        malware_scan?: string;
      };
    }>(
      `
      SELECT
        original_filename,
        stored_filename,
        storage_key,
        storage_backend,
        sha256_hash,
        validation_result_json
      FROM assessment_evidence_files
      WHERE id = $1
      `,
      [evidenceId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].original_filename).toBe("proof.csv");
    expect(row.rows[0].stored_filename).not.toBe("proof.csv");
    expect(row.rows[0].storage_key).not.toBe("proof.csv");
    expect(row.rows[0].storage_backend).toBe("LOCAL");
    expect(row.rows[0].sha256_hash).toBe(
      createHash("sha256").update(content).digest("hex"),
    );
    expect(row.rows[0].validation_result_json).toMatchObject({
      extension_allowed: true,
      mime_detected: "text/csv",
      size_allowed: true,
      sha256: row.rows[0].sha256_hash,
      malware_scan: "NOT_PERFORMED",
    });
  });

  it("blocks unsafe storage path resolution during download", async () => {
    const admin = await loginAs("admin");
    const cycleId = await createDraft(admin.accessToken);
    const itemId = await firstItemId(cycleId);
    const uploaded = await uploadEvidence(admin.accessToken, cycleId, itemId);
    expect(uploaded.status).toBe(201);
    const evidenceId = String(uploaded.body.evidence.id);

    await tx.query(
      `
      UPDATE assessment_evidence_files
      SET storage_key = '../outside'
      WHERE id = $1
      `,
      [evidenceId],
    );

    const download = await request(app)
      .get(`/evidence/${evidenceId}/download`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(download.status).toBe(500);
    expect(download.body.code).toBe("EVIDENCE_STORAGE_PATH_INVALID");
  });

  it("requires reason for soft remove and blocks download after removal", async () => {
    const admin = await loginAs("admin");
    const cycleId = await createDraft(admin.accessToken);
    const itemId = await firstItemId(cycleId);
    const uploaded = await uploadEvidence(admin.accessToken, cycleId, itemId);
    expect(uploaded.status).toBe(201);
    const evidenceId = String(uploaded.body.evidence.id);

    const invalidRemove = await request(app)
      .post(`/evidence/${evidenceId}/remove`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason: "short" });
    expect(invalidRemove.status).toBe(400);
    expect(invalidRemove.body.code).toBe("EVIDENCE_REMOVE_REASON_INVALID");

    const removed = await request(app)
      .post(`/evidence/${evidenceId}/remove`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason: "No longer applicable for this draft item." });
    expect(removed.status).toBe(200);
    expect(removed.body.evidence.status).toBe("REMOVED");

    const download = await request(app)
      .get(`/evidence/${evidenceId}/download`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(download.status).toBe(404);
    expect(download.body.code).toBe("EVIDENCE_NOT_FOUND");
  });

  it("blocks upload/remove after FINALIZED_INTERNAL", async () => {
    const admin = await loginAs("admin");
    const cycleId = await createDraft(admin.accessToken);
    const itemId = await firstItemId(cycleId);

    await tx.query(
      `
      UPDATE assessment_requirement_items
      SET assessment_status = 'NOT_COMPLIANT',
          updated_by_user_id = $2
      WHERE assessment_cycle_id = $1
      `,
      [cycleId, admin.userId],
    );
    await seedChecklistForRequiredItems(cycleId, admin.userId);

    const finalized = await request(app)
      .post(`/assessments/cycles/${cycleId}/finalize-internal`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({});
    expect(finalized.status).toBe(200);

    const blockedUpload = await uploadEvidence(admin.accessToken, cycleId, itemId);
    expect(blockedUpload.status).toBe(409);
    expect(blockedUpload.body.code).toBe("ASSESSMENT_CYCLE_FINALIZED");

    await tx.query(
      `
      UPDATE assessment_cycles
      SET status = 'DRAFT',
          finalized_internal_by_user_id = NULL,
          finalized_internal_at = NULL
      WHERE id = $1
      `,
      [cycleId],
    );
    const uploaded = await uploadEvidence(admin.accessToken, cycleId, itemId);
    expect(uploaded.status).toBe(201);
    const evidenceId = String(uploaded.body.evidence.id);

    await tx.query(
      `
      UPDATE assessment_cycles
      SET status = 'FINALIZED_INTERNAL',
          finalized_internal_by_user_id = $2,
          finalized_internal_at = now()
      WHERE id = $1
      `,
      [cycleId, admin.userId],
    );

    const blockedRemove = await request(app)
      .post(`/evidence/${evidenceId}/remove`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason: "Removing after finalization should fail." });
    expect(blockedRemove.status).toBe(409);
    expect(blockedRemove.body.code).toBe("ASSESSMENT_CYCLE_FINALIZED");
  });

  it("creates audit rows for upload, download, and remove", async () => {
    const admin = await loginAs("admin");
    const cycleId = await createDraft(admin.accessToken);
    const itemId = await firstItemId(cycleId);
    const uploaded = await uploadEvidence(admin.accessToken, cycleId, itemId);
    expect(uploaded.status).toBe(201);
    const evidenceId = String(uploaded.body.evidence.id);

    const downloaded = await request(app)
      .get(`/evidence/${evidenceId}/download`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(downloaded.status).toBe(200);

    const removed = await request(app)
      .post(`/evidence/${evidenceId}/remove`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ reason: "Removing for testing immutable audit records." });
    expect(removed.status).toBe(200);

    const audit = await tx.query<{ event_type: string; count: string }>(
      `
      SELECT event_type, count(*)::text AS count
      FROM auth_audit_logs
      WHERE event_type IN (
        'EVIDENCE_UPLOADED',
        'EVIDENCE_DOWNLOADED',
        'EVIDENCE_REMOVED'
      )
      GROUP BY event_type
      `,
    );
    const map = new Map(audit.rows.map((row) => [row.event_type, Number(row.count)]));
    expect((map.get("EVIDENCE_UPLOADED") ?? 0) >= 1).toBe(true);
    expect((map.get("EVIDENCE_DOWNLOADED") ?? 0) >= 1).toBe(true);
    expect((map.get("EVIDENCE_REMOVED") ?? 0) >= 1).toBe(true);
  });
});
