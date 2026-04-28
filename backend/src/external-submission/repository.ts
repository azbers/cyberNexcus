import type { Pool, PoolClient } from "pg";

import { AUTH_ERRORS } from "../auth/errors.js";
import {
  AUDIT_EVENT_TYPES,
  AUDIT_SEVERITIES,
  type AuditEventType,
  type AuditSeverity,
} from "../auth/types.js";

type QueryExecutor = Pick<Pool, "query"> | Pick<PoolClient, "query">;

type ExternalSubmissionStatus = "SUBMITTED" | "WITHDRAWN";
type PackageStatus = "CREATED" | "VOIDED";
type AssessmentCycleStatus =
  | "DRAFT"
  | "FINALIZED_INTERNAL"
  | "READY_FOR_SUBMISSION";

type ActorProfile = {
  user_id: string;
  org_id: string;
  role: string;
};

type PackageForExternalSubmission = {
  id: string;
  org_id: string;
  assessment_cycle_id: string;
  package_number: string;
  status: PackageStatus;
  manifest_json: Record<string, unknown>;
  manifest_hash: string;
  cycle_status: AssessmentCycleStatus;
};

type ExternalSubmissionRecord = {
  id: string;
  org_id: string;
  submission_package_id: string;
  assessment_cycle_id: string;
  submission_number: string;
  status: ExternalSubmissionStatus;
  submitted_by_user_id: string;
  submitted_at: Date;
  withdrawn_by_user_id: string | null;
  withdrawn_at: Date | null;
  withdraw_reason: string | null;
  created_at: Date;
  updated_at: Date;
};

type InsertExternalSubmissionInput = {
  orgId: string;
  submissionPackageId: string;
  assessmentCycleId: string;
  submissionNumber: string;
  submittedByUserId: string;
  submittedAt: Date;
};

type WithdrawExternalSubmissionInput = {
  orgId: string;
  submissionId: string;
  withdrawnByUserId: string;
  withdrawnAt: Date;
  withdrawReason: string;
};

type ListExternalSubmissionsResult = {
  total: number;
  items: ExternalSubmissionRecord[];
};

type AppendExternalSubmissionAuditInput = {
  eventType: "EXTERNAL_SUBMISSION_CREATED" | "EXTERNAL_SUBMISSION_WITHDRAWN";
  severity: AuditSeverity;
  userId: string;
  orgId: string;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
};

function assertTx(tx?: PoolClient): PoolClient {
  if (!tx) {
    throw AUTH_ERRORS.MISSING_TX_CONTEXT();
  }
  return tx;
}

function asNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number(value);
  }
  return 0;
}

function validateAuditEvent(input: AppendExternalSubmissionAuditInput): void {
  if (!AUDIT_EVENT_TYPES.includes(input.eventType as AuditEventType)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
  if (!AUDIT_SEVERITIES.includes(input.severity)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
}

export class ExternalSubmissionRepository {
  private readonly readExecutor: QueryExecutor;

  public constructor(readExecutor: QueryExecutor) {
    this.readExecutor = readExecutor;
  }

  public async findActorProfile(
    tx: PoolClient | undefined,
    userId: string,
  ): Promise<ActorProfile | null> {
    const client = assertTx(tx);
    const result = await client.query<ActorProfile>(
      `
      SELECT id AS user_id, org_id, role
      FROM users
      WHERE id = $1
      `,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  public async getPackageForSubmitUpdate(
    tx: PoolClient | undefined,
    orgId: string,
    packageId: string,
  ): Promise<PackageForExternalSubmission | null> {
    const client = assertTx(tx);
    const result = await client.query<PackageForExternalSubmission>(
      `
      SELECT
        p.id,
        p.org_id,
        p.assessment_cycle_id,
        p.package_number,
        p.status,
        p.manifest_json,
        p.manifest_hash,
        c.status AS cycle_status
      FROM assessment_submission_packages p
      JOIN assessment_cycles c ON c.id = p.assessment_cycle_id
      WHERE p.org_id = $1
        AND p.id = $2
      FOR UPDATE OF p
      `,
      [orgId, packageId],
    );
    return result.rows[0] ?? null;
  }

  public async getActiveSubmissionByPackage(
    orgId: string,
    packageId: string,
    executor?: QueryExecutor,
  ): Promise<ExternalSubmissionRecord | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<ExternalSubmissionRecord>(
      `
      SELECT
        id,
        org_id,
        submission_package_id,
        assessment_cycle_id,
        submission_number,
        status,
        submitted_by_user_id,
        submitted_at,
        withdrawn_by_user_id,
        withdrawn_at,
        withdraw_reason,
        created_at,
        updated_at
      FROM external_submissions
      WHERE org_id = $1
        AND submission_package_id = $2
        AND status = 'SUBMITTED'
      `,
      [orgId, packageId],
    );
    return result.rows[0] ?? null;
  }

  public async insertSubmission(
    tx: PoolClient | undefined,
    input: InsertExternalSubmissionInput,
  ): Promise<ExternalSubmissionRecord> {
    const client = assertTx(tx);
    const result = await client.query<ExternalSubmissionRecord>(
      `
      INSERT INTO external_submissions (
        org_id,
        submission_package_id,
        assessment_cycle_id,
        submission_number,
        status,
        submitted_by_user_id,
        submitted_at
      )
      VALUES ($1, $2, $3, $4, 'SUBMITTED', $5, $6)
      RETURNING
        id,
        org_id,
        submission_package_id,
        assessment_cycle_id,
        submission_number,
        status,
        submitted_by_user_id,
        submitted_at,
        withdrawn_by_user_id,
        withdrawn_at,
        withdraw_reason,
        created_at,
        updated_at
      `,
      [
        input.orgId,
        input.submissionPackageId,
        input.assessmentCycleId,
        input.submissionNumber,
        input.submittedByUserId,
        input.submittedAt,
      ],
    );
    return result.rows[0];
  }

  public async getSubmissionForWithdrawUpdate(
    tx: PoolClient | undefined,
    orgId: string,
    submissionId: string,
  ): Promise<ExternalSubmissionRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<ExternalSubmissionRecord>(
      `
      SELECT
        id,
        org_id,
        submission_package_id,
        assessment_cycle_id,
        submission_number,
        status,
        submitted_by_user_id,
        submitted_at,
        withdrawn_by_user_id,
        withdrawn_at,
        withdraw_reason,
        created_at,
        updated_at
      FROM external_submissions
      WHERE org_id = $1
        AND id = $2
      FOR UPDATE
      `,
      [orgId, submissionId],
    );
    return result.rows[0] ?? null;
  }

  public async withdrawSubmission(
    tx: PoolClient | undefined,
    input: WithdrawExternalSubmissionInput,
  ): Promise<ExternalSubmissionRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<ExternalSubmissionRecord>(
      `
      UPDATE external_submissions
      SET status = 'WITHDRAWN',
          withdrawn_by_user_id = $3,
          withdrawn_at = $4,
          withdraw_reason = $5
      WHERE org_id = $1
        AND id = $2
        AND status = 'SUBMITTED'
      RETURNING
        id,
        org_id,
        submission_package_id,
        assessment_cycle_id,
        submission_number,
        status,
        submitted_by_user_id,
        submitted_at,
        withdrawn_by_user_id,
        withdrawn_at,
        withdraw_reason,
        created_at,
        updated_at
      `,
      [
        input.orgId,
        input.submissionId,
        input.withdrawnByUserId,
        input.withdrawnAt,
        input.withdrawReason,
      ],
    );
    return result.rows[0] ?? null;
  }

  public async getSubmissionById(
    orgId: string,
    submissionId: string,
    executor?: QueryExecutor,
  ): Promise<ExternalSubmissionRecord | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<ExternalSubmissionRecord>(
      `
      SELECT
        id,
        org_id,
        submission_package_id,
        assessment_cycle_id,
        submission_number,
        status,
        submitted_by_user_id,
        submitted_at,
        withdrawn_by_user_id,
        withdrawn_at,
        withdraw_reason,
        created_at,
        updated_at
      FROM external_submissions
      WHERE org_id = $1
        AND id = $2
      `,
      [orgId, submissionId],
    );
    return result.rows[0] ?? null;
  }

  public async packageExistsForOrg(
    orgId: string,
    packageId: string,
    executor?: QueryExecutor,
  ): Promise<boolean> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1
        FROM assessment_submission_packages
        WHERE org_id = $1
          AND id = $2
      ) AS exists
      `,
      [orgId, packageId],
    );
    return result.rows[0]?.exists ?? false;
  }

  public async cycleExistsForOrg(
    orgId: string,
    cycleId: string,
    executor?: QueryExecutor,
  ): Promise<boolean> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1
        FROM assessment_cycles
        WHERE org_id = $1
          AND id = $2
      ) AS exists
      `,
      [orgId, cycleId],
    );
    return result.rows[0]?.exists ?? false;
  }

  public async listSubmissionsByPackage(
    orgId: string,
    packageId: string,
    status: ExternalSubmissionStatus | null,
    limit: number,
    offset: number,
    executor?: QueryExecutor,
  ): Promise<ListExternalSubmissionsResult> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<ExternalSubmissionRecord & { total_count: string }>(
      `
      SELECT
        id,
        org_id,
        submission_package_id,
        assessment_cycle_id,
        submission_number,
        status,
        submitted_by_user_id,
        submitted_at,
        withdrawn_by_user_id,
        withdrawn_at,
        withdraw_reason,
        created_at,
        updated_at,
        count(*) OVER()::text AS total_count
      FROM external_submissions
      WHERE org_id = $1
        AND submission_package_id = $2
        AND ($3::text IS NULL OR status = $3)
      ORDER BY submitted_at DESC, created_at DESC
      LIMIT $4 OFFSET $5
      `,
      [orgId, packageId, status, limit, offset],
    );
    return {
      total: asNumber(result.rows[0]?.total_count ?? 0),
      items: result.rows,
    };
  }

  public async listSubmissionsByCycle(
    orgId: string,
    cycleId: string,
    status: ExternalSubmissionStatus | null,
    limit: number,
    offset: number,
    executor?: QueryExecutor,
  ): Promise<ListExternalSubmissionsResult> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<ExternalSubmissionRecord & { total_count: string }>(
      `
      SELECT
        id,
        org_id,
        submission_package_id,
        assessment_cycle_id,
        submission_number,
        status,
        submitted_by_user_id,
        submitted_at,
        withdrawn_by_user_id,
        withdrawn_at,
        withdraw_reason,
        created_at,
        updated_at,
        count(*) OVER()::text AS total_count
      FROM external_submissions
      WHERE org_id = $1
        AND assessment_cycle_id = $2
        AND ($3::text IS NULL OR status = $3)
      ORDER BY submitted_at DESC, created_at DESC
      LIMIT $4 OFFSET $5
      `,
      [orgId, cycleId, status, limit, offset],
    );
    return {
      total: asNumber(result.rows[0]?.total_count ?? 0),
      items: result.rows,
    };
  }

  public async appendAuditEvent(
    tx: PoolClient | undefined,
    input: AppendExternalSubmissionAuditInput,
  ): Promise<void> {
    validateAuditEvent(input);
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
      )
      VALUES ($1, $2, $3, $4, NULL, $5::inet, $6, $7::jsonb)
      `,
      [
        input.eventType,
        input.severity,
        input.userId,
        input.orgId,
        input.ipAddress,
        input.userAgent,
        JSON.stringify(input.metadata),
      ],
    );
  }
}

export type {
  ActorProfile,
  ExternalSubmissionRecord,
  ExternalSubmissionStatus,
  InsertExternalSubmissionInput,
  PackageForExternalSubmission,
  WithdrawExternalSubmissionInput,
};
