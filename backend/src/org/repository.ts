import type { PoolClient } from "pg";

import { AUTH_ERRORS } from "../auth/errors.js";
import {
  AUDIT_EVENT_TYPES,
  AUDIT_SEVERITIES,
  type AuditEventType,
  type AuditSeverity,
  type OrgStatus,
} from "../auth/types.js";

type OrganizationRecord = {
  id: string;
  name: string;
  status: OrgStatus;
  created_at: Date;
  rejection_reason: string | null;
  suspended_at: Date | null;
  deactivated_at: Date | null;
};

type PendingOrganizationItem = {
  id: string;
  name: string;
  status: OrgStatus;
  created_at: Date;
};

type PendingOrganizationsResult = {
  total: number;
  items: PendingOrganizationItem[];
};

type ListPendingOrganizationsInput = {
  limit: number;
  offset: number;
};

type UpdateOrganizationLifecycleInput = {
  orgId: string;
  status: OrgStatus;
  rejectionReason: string | null;
  suspendedAt: Date | null;
  deactivatedAt: Date | null;
};

type OrganizationLifecycleAuditEventType =
  | "ORG_APPROVED"
  | "ORG_REJECTED"
  | "ORG_SUSPENDED"
  | "ORG_REACTIVATED";

type AppendOrgAuditEventInput = {
  eventType: OrganizationLifecycleAuditEventType;
  severity: AuditSeverity;
  userId: string;
  orgId: string;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
};

type ActorProfile = {
  user_id: string;
  org_id: string;
  role: string;
};

function assertTx(tx?: PoolClient): PoolClient {
  if (!tx) {
    throw AUTH_ERRORS.MISSING_TX_CONTEXT();
  }
  return tx;
}

function validateAuditInput(event: AppendOrgAuditEventInput): void {
  if (!AUDIT_EVENT_TYPES.includes(event.eventType)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
  if (!AUDIT_SEVERITIES.includes(event.severity)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
}

export class OrganizationRepository {
  public async getOrganizationForUpdate(
    tx: PoolClient | undefined,
    orgId: string,
  ): Promise<OrganizationRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<OrganizationRecord>(
      `
      SELECT
        id,
        name,
        status,
        created_at,
        rejection_reason,
        suspended_at,
        deactivated_at
      FROM organizations
      WHERE id = $1
      FOR UPDATE
      `,
      [orgId],
    );
    return result.rows[0] ?? null;
  }

  public async updateOrganizationLifecycle(
    tx: PoolClient | undefined,
    input: UpdateOrganizationLifecycleInput,
  ): Promise<OrganizationRecord> {
    const client = assertTx(tx);
    const result = await client.query<OrganizationRecord>(
      `
      UPDATE organizations
      SET status = $2,
          rejection_reason = $3,
          suspended_at = $4,
          deactivated_at = $5
      WHERE id = $1
      RETURNING
        id,
        name,
        status,
        created_at,
        rejection_reason,
        suspended_at,
        deactivated_at
      `,
      [
        input.orgId,
        input.status,
        input.rejectionReason,
        input.suspendedAt,
        input.deactivatedAt,
      ],
    );
    return result.rows[0];
  }

  public async listPendingOrganizations(
    tx: PoolClient | undefined,
    input: ListPendingOrganizationsInput,
  ): Promise<PendingOrganizationsResult> {
    const client = assertTx(tx);
    const totalResult = await client.query<{ total: string }>(
      `
      SELECT count(*)::text AS total
      FROM organizations
      WHERE status = 'PENDING'
      `,
    );
    const itemsResult = await client.query<PendingOrganizationItem>(
      `
      SELECT id, name, status, created_at
      FROM organizations
      WHERE status = 'PENDING'
      ORDER BY created_at ASC
      LIMIT $1 OFFSET $2
      `,
      [input.limit, input.offset],
    );
    return {
      total: Number(totalResult.rows[0]?.total ?? 0),
      items: itemsResult.rows,
    };
  }

  public async appendAuditEvent(
    tx: PoolClient | undefined,
    event: AppendOrgAuditEventInput,
  ): Promise<void> {
    validateAuditInput(event);
    const client = assertTx(tx);
    await client.query(
      `
      INSERT INTO auth_audit_logs (
        event_type,
        severity,
        user_id,
        org_id,
        session_id,
        ip_address,
        user_agent,
        metadata
      ) VALUES (
        $1, $2, $3, $4, NULL, $5::inet, $6, $7::jsonb
      )
      `,
      [
        event.eventType,
        event.severity,
        event.userId,
        event.orgId,
        event.ipAddress,
        event.userAgent,
        JSON.stringify(event.metadata),
      ],
    );
  }

  public async findActorProfile(
    tx: PoolClient | undefined,
    userId: string,
  ): Promise<ActorProfile | null> {
    const client = assertTx(tx);
    const result = await client.query<ActorProfile>(
      `
      SELECT
        id AS user_id,
        org_id,
        role
      FROM users
      WHERE id = $1
      `,
      [userId],
    );
    return result.rows[0] ?? null;
  }
}

export type {
  AppendOrgAuditEventInput,
  OrganizationLifecycleAuditEventType,
  OrganizationRecord,
  PendingOrganizationItem,
  PendingOrganizationsResult,
};
