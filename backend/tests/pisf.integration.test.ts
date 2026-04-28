import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import { createAuthApp } from "../src/auth/app.js";
import { AuthRepository } from "../src/auth/repository.js";
import { AuthService } from "../src/auth/service.js";
import { createPool } from "../src/db/pool.js";
import {
  beginIsolatedTestTransaction,
  DEFAULT_TEST_DATABASE_URL,
  rollbackAndRelease,
  seedApprovedUser,
} from "./test-db.js";

const TEST_JWT_SECRET = "test-jwt-secret";
const HASH = "a".repeat(64);

type SeededPisf = {
  domainAId: string;
  domainBId: string;
  controlAId: string;
  controlBId: string;
};

describe("PISF integration", () => {
  let pool: Pool;
  let tx: PoolClient;
  let app: ReturnType<typeof createAuthApp>;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL);
  });

  beforeEach(async () => {
    tx = await beginIsolatedTestTransaction(pool);
    const repository = new AuthRepository();
    const service = new AuthService({
      repository,
      jwtSecret: TEST_JWT_SECRET,
    });
    app = createAuthApp({
      pool,
      repository,
      service,
      jwtSecret: TEST_JWT_SECRET,
      txOverride: tx,
    });
  });

  afterEach(async () => {
    await rollbackAndRelease(tx);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function loginAs(role: "admin" | "viewer"): Promise<{ accessToken: string; orgId: string }> {
    const seeded = await seedApprovedUser(tx, { role });
    const login = await request(app).post("/auth/login").send({
      orgId: seeded.orgId,
      email: seeded.email,
      password: seeded.password,
    });
    expect(login.status).toBe(200);
    return { accessToken: String(login.body.accessToken), orgId: seeded.orgId };
  }

  async function seedPisfData(): Promise<SeededPisf> {
    const batch = await tx.query<{ id: string }>(
      `
      INSERT INTO pisf_import_batches (source_file_name, source_checksum, status, completed_at)
      VALUES ('seed.json', $1, 'COMPLETED', now())
      RETURNING id
      `,
      [HASH],
    );
    const batchId = batch.rows[0].id;

    const domains = await tx.query<{ id: string; domain_code: string }>(
      `
      INSERT INTO pisf_domains (domain_code, name, source_hash, last_import_batch_id)
      VALUES
        ($1, $2, $3, $4),
        ($5, $6, $7, $4)
      RETURNING id, domain_code
      `,
      [
        `domain_a_${randomUUID().slice(0, 8)}`,
        "Domain A",
        HASH,
        batchId,
        `domain_b_${randomUUID().slice(0, 8)}`,
        "Domain B",
        HASH,
      ],
    );
    const domainA = domains.rows[0];
    const domainB = domains.rows[1];

    const controls = await tx.query<{ id: string; control_code: string }>(
      `
      INSERT INTO pisf_controls (
        domain_id,
        control_code,
        phase,
        area,
        sub_area,
        title,
        statement_text,
        source_statement_text,
        raw_source_json,
        source_hash,
        last_import_batch_id
      )
      VALUES
        ($1, $2, 'Phase 1', 'Area 1', 'Sub 1', 'Network Segmentation', 'Segment networks', 'Segment networks', '{}'::jsonb, $3, $4),
        ($5, $6, 'Phase 2', 'Area 2', 'Sub 2', 'Asset Inventory', 'Track assets', 'Track assets', '{}'::jsonb, $3, $4)
      RETURNING id, control_code
      `,
      [
        domainA.id,
        `CTRL-A-${randomUUID().slice(0, 8)}`,
        HASH,
        batchId,
        domainB.id,
        `CTRL-B-${randomUUID().slice(0, 8)}`,
      ],
    );
    const controlA = controls.rows[0];
    const controlB = controls.rows[1];

    await tx.query(
      `
      INSERT INTO pisf_requirements (
        control_id,
        requirement_key,
        ordinal,
        requirement_text,
        source_control_text,
        source_fragment,
        derivation_method,
        status,
        is_active,
        deprecated_at,
        source_hash,
        last_import_batch_id
      )
      VALUES
        ($1, $2, 1, 'Active requirement A', 'Segment networks', null, 'single_statement', 'ACTIVE', TRUE, NULL, $5, $6),
        ($1, $3, 2, 'Needs review requirement A', 'Segment networks', null, 'manual_review_required', 'NEEDS_REVIEW', TRUE, NULL, $5, $6),
        ($4, $7, 1, 'Active requirement B', 'Track assets', null, 'single_statement', 'ACTIVE', TRUE, NULL, $5, $6)
      `,
      [
        controlA.id,
        `${controlA.control_code}::1`,
        `${controlA.control_code}::2`,
        controlB.id,
        HASH,
        batchId,
        `${controlB.control_code}::1`,
      ],
    );

    return {
      domainAId: domainA.id,
      domainBId: domainB.id,
      controlAId: controlA.id,
      controlBId: controlB.id,
    };
  }

  it("requires authentication for /pisf endpoints", async () => {
    const response = await request(app).get("/pisf/domains");
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHORIZED");
  });

  it("shows only ACTIVE requirements to non-admin users", async () => {
    await seedPisfData();
    const viewer = await loginAs("viewer");

    const response = await request(app)
      .get("/pisf/requirements?status=NEEDS_REVIEW")
      .set("Authorization", `Bearer ${viewer.accessToken}`);

    expect(response.status).toBe(200);
    expect(response.body.items.length).toBeGreaterThan(0);
    expect(response.body.items.every((item: { status: string }) => item.status === "ACTIVE")).toBe(
      true,
    );
  });

  it("allows admins to query NEEDS_REVIEW requirements", async () => {
    await seedPisfData();
    const admin = await loginAs("admin");

    const response = await request(app)
      .get("/pisf/requirements?status=NEEDS_REVIEW")
      .set("Authorization", `Bearer ${admin.accessToken}`);

    expect(response.status).toBe(200);
    expect(response.body.total).toBeGreaterThanOrEqual(1);
    expect(response.body.items.some((item: { status: string }) => item.status === "NEEDS_REVIEW")).toBe(
      true,
    );
  });

  it("supports controls filters, search, and pagination bounds", async () => {
    const seeded = await seedPisfData();
    const admin = await loginAs("admin");

    const response = await request(app)
      .get("/pisf/controls")
      .query({
        domainId: seeded.domainAId,
        phase: "Phase 1",
        search: "segment",
        page: 1,
        pageSize: 500,
      })
      .set("Authorization", `Bearer ${admin.accessToken}`);

    expect(response.status).toBe(200);
    expect(response.body.page).toBe(1);
    expect(response.body.pageSize).toBe(100);
    expect(response.body.items.length).toBe(1);
    expect(response.body.items[0].id).toBe(seeded.controlAId);
  });

  it("supports requirement filters by domain and control", async () => {
    const seeded = await seedPisfData();
    const admin = await loginAs("admin");

    const byControl = await request(app)
      .get("/pisf/requirements")
      .query({ controlId: seeded.controlBId, status: "ACTIVE" })
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(byControl.status).toBe(200);
    expect(byControl.body.items).toHaveLength(1);

    const byDomain = await request(app)
      .get("/pisf/requirements")
      .query({ domainId: seeded.domainAId, status: "NEEDS_REVIEW" })
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(byDomain.status).toBe(200);
    expect(byDomain.body.items.every((item: { control_id: string }) => item.control_id === seeded.controlAId)).toBe(
      true,
    );
  });

  it("returns resource by id and 404 for missing resources", async () => {
    const seeded = await seedPisfData();
    const admin = await loginAs("admin");

    const found = await request(app)
      .get(`/pisf/domains/${seeded.domainAId}`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(found.status).toBe(200);
    expect(found.body.id).toBe(seeded.domainAId);

    const missing = await request(app)
      .get(`/pisf/domains/${randomUUID()}`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("PISF_RESOURCE_NOT_FOUND");
  });
});
