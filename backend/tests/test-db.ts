import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export const DEFAULT_TEST_DATABASE_URL =
  "postgresql://cybernexus_admin:cybernexus_password_2026@localhost:5432/cybernexus_db";

export async function beginIsolatedTestTransaction(pool: Pool): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout = '60s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
  return client;
}

export async function rollbackAndRelease(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

export async function seedApprovedUser(
  tx: PoolClient,
  options?: {
    email?: string;
    password?: string;
    emailVerified?: boolean;
    orgStatus?: "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED";
    role?:
      | "admin"
      | "auditor"
      | "commenter"
      | "viewer"
      | "responsible_officer"
      | "it_security_lead";
  },
): Promise<{
  orgId: string;
  userId: string;
  email: string;
  password: string;
}> {
  const email = options?.email ?? `user-${randomUUID()}@example.com`;
  const password = options?.password ?? "Password!234";
  const passwordHash = await bcrypt.hash(password, 12);

  const organization = await tx.query<{ id: string }>(
    `
    INSERT INTO organizations (name, status)
    VALUES ($1, $2)
    RETURNING id
    `,
    [`Org-${randomUUID()}`, options?.orgStatus ?? "APPROVED"],
  );
  const orgId = organization.rows[0].id;

  const user = await tx.query<{ id: string }>(
    `
    INSERT INTO users (org_id, email, password_hash, role, email_verified)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
    `,
    [orgId, email, passwordHash, options?.role ?? "admin", options?.emailVerified ?? true],
  );
  const userId = user.rows[0].id;

  await tx.query(
    `
    INSERT INTO password_history (user_id, password_hash)
    VALUES ($1, $2)
    `,
    [userId, passwordHash],
  );

  return { orgId, userId, email, password };
}
