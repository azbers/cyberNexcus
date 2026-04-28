import type { Pool, PoolClient } from "pg";

import { AUTH_ERRORS } from "../auth/errors.js";
import {
  AUDIT_EVENT_TYPES,
  AUDIT_SEVERITIES,
  type AuditEventType,
  type AuditSeverity,
} from "../auth/types.js";

type QueryExecutor = Pick<Pool, "query"> | Pick<PoolClient, "query">;

type PkcertRole = "PKCERT_ADMIN" | "PKCERT_REVIEWER";
type IntakeStatus = "PENDING_INTAKE" | "IN_INTAKE_REVIEW" | "INTAKE_REVIEWED";
type ExternalSubmissionStatus = "SUBMITTED" | "WITHDRAWN";

type PkcertUser = {
  user_id: string;
  org_id: string;
  pkcert_role: PkcertRole;
  is_active: boolean;
};

type IntakeReviewRecord = {
  id: string;
  external_submission_id: string;
  org_id: string;
  assessment_cycle_id: string;
  submission_package_id: string;
  status: IntakeStatus;
  assigned_to_user_id: string | null;
  assigned_at: Date | null;
  started_by_user_id: string | null;
  started_at: Date | null;
  reviewed_by_user_id: string | null;
  reviewed_at: Date | null;
  internal_notes: string | null;
  created_at: Date;
  updated_at: Date;
  external_submission_status: ExternalSubmissionStatus;
};

type CreateIntakeReviewInput = {
  externalSubmissionId: string;
  orgId: string;
  assessmentCycleId: string;
  submissionPackageId: string;
};

type AssignReviewerInput = {
  intakeReviewId: string;
  reviewerUserId: string;
  assignedAt: Date;
};

type StartReviewInput = {
  intakeReviewId: string;
  actorUserId: string;
  startedAt: Date;
  assignToActorIfUnassigned: boolean;
};

type MarkReviewedInput = {
  intakeReviewId: string;
  actorUserId: string;
  reviewedAt: Date;
};

type UpdateNotesInput = {
  intakeReviewId: string;
  internalNotes: string | null;
};

type ListIntakeReviewsInput = {
  status: IntakeStatus | null;
  assignedToUserId: string | null;
  limit: number;
  offset: number;
};

type ListIntakeReviewsResult = {
  total: number;
  items: IntakeReviewRecord[];
};

type AppendPkcertIntakeAuditInput = {
  eventType:
    | "PKCERT_INTAKE_CREATED"
    | "PKCERT_INTAKE_ASSIGNED"
    | "PKCERT_INTAKE_STARTED"
    | "PKCERT_INTAKE_REVIEWED"
    | "PKCERT_INTAKE_NOTES_UPDATED";
  severity: AuditSeverity;
  userId: string | null;
  orgId: string | null;
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

function validateAuditEvent(input: AppendPkcertIntakeAuditInput): void {
  if (!AUDIT_EVENT_TYPES.includes(input.eventType as AuditEventType)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
  if (!AUDIT_SEVERITIES.includes(input.severity)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
}

export class PkcertIntakeRepository {
  private readonly readExecutor: QueryExecutor;

  public constructor(readExecutor: QueryExecutor) {
    this.readExecutor = readExecutor;
  }

  public async findPkcertUser(
    tx: PoolClient | undefined,
    userId: string,
  ): Promise<PkcertUser | null> {
    const client = assertTx(tx);
    const result = await client.query<PkcertUser>(
      `
      SELECT
        pu.user_id,
        u.org_id,
        pu.pkcert_role,
        pu.is_active
      FROM pkcert_users pu
      JOIN users u ON u.id = pu.user_id
      WHERE pu.user_id = $1
      `,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  public async createIntakeReview(
    tx: PoolClient | undefined,
    input: CreateIntakeReviewInput,
  ): Promise<IntakeReviewRecord> {
    const client = assertTx(tx);
    const result = await client.query<IntakeReviewRecord>(
      `
      INSERT INTO pkcert_intake_reviews (
        external_submission_id,
        org_id,
        assessment_cycle_id,
        submission_package_id,
        status
      )
      VALUES ($1, $2, $3, $4, 'PENDING_INTAKE')
      RETURNING
        id,
        external_submission_id,
        org_id,
        assessment_cycle_id,
        submission_package_id,
        status,
        assigned_to_user_id,
        assigned_at,
        started_by_user_id,
        started_at,
        reviewed_by_user_id,
        reviewed_at,
        internal_notes,
        created_at,
        updated_at,
        'SUBMITTED'::text AS external_submission_status
      `,
      [
        input.externalSubmissionId,
        input.orgId,
        input.assessmentCycleId,
        input.submissionPackageId,
      ],
    );
    return result.rows[0];
  }

  public async getIntakeByExternalSubmissionId(
    externalSubmissionId: string,
    executor?: QueryExecutor,
  ): Promise<IntakeReviewRecord | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<IntakeReviewRecord>(
      `
      SELECT
        pir.id,
        pir.external_submission_id,
        pir.org_id,
        pir.assessment_cycle_id,
        pir.submission_package_id,
        pir.status,
        pir.assigned_to_user_id,
        pir.assigned_at,
        pir.started_by_user_id,
        pir.started_at,
        pir.reviewed_by_user_id,
        pir.reviewed_at,
        pir.internal_notes,
        pir.created_at,
        pir.updated_at,
        es.status AS external_submission_status
      FROM pkcert_intake_reviews pir
      JOIN external_submissions es ON es.id = pir.external_submission_id
      WHERE pir.external_submission_id = $1
      `,
      [externalSubmissionId],
    );
    return result.rows[0] ?? null;
  }

  public async getIntakeForUpdate(
    tx: PoolClient | undefined,
    externalSubmissionId: string,
  ): Promise<IntakeReviewRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<IntakeReviewRecord>(
      `
      SELECT
        pir.id,
        pir.external_submission_id,
        pir.org_id,
        pir.assessment_cycle_id,
        pir.submission_package_id,
        pir.status,
        pir.assigned_to_user_id,
        pir.assigned_at,
        pir.started_by_user_id,
        pir.started_at,
        pir.reviewed_by_user_id,
        pir.reviewed_at,
        pir.internal_notes,
        pir.created_at,
        pir.updated_at,
        es.status AS external_submission_status
      FROM pkcert_intake_reviews pir
      JOIN external_submissions es ON es.id = pir.external_submission_id
      WHERE pir.external_submission_id = $1
      FOR UPDATE OF pir
      `,
      [externalSubmissionId],
    );
    return result.rows[0] ?? null;
  }

  public async listIntakeReviews(
    input: ListIntakeReviewsInput,
    executor?: QueryExecutor,
  ): Promise<ListIntakeReviewsResult> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<IntakeReviewRecord & { total_count: string }>(
      `
      SELECT
        pir.id,
        pir.external_submission_id,
        pir.org_id,
        pir.assessment_cycle_id,
        pir.submission_package_id,
        pir.status,
        pir.assigned_to_user_id,
        pir.assigned_at,
        pir.started_by_user_id,
        pir.started_at,
        pir.reviewed_by_user_id,
        pir.reviewed_at,
        pir.internal_notes,
        pir.created_at,
        pir.updated_at,
        es.status AS external_submission_status,
        count(*) OVER()::text AS total_count
      FROM pkcert_intake_reviews pir
      JOIN external_submissions es ON es.id = pir.external_submission_id
      WHERE ($1::text IS NULL OR pir.status = $1)
        AND ($2::uuid IS NULL OR pir.assigned_to_user_id = $2)
      ORDER BY pir.created_at DESC, pir.id DESC
      LIMIT $3 OFFSET $4
      `,
      [input.status, input.assignedToUserId, input.limit, input.offset],
    );
    return {
      total: asNumber(result.rows[0]?.total_count ?? 0),
      items: result.rows,
    };
  }

  public async assignReviewer(
    tx: PoolClient | undefined,
    input: AssignReviewerInput,
  ): Promise<IntakeReviewRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<IntakeReviewRecord>(
      `
      UPDATE pkcert_intake_reviews pir
      SET assigned_to_user_id = $2,
          assigned_at = $3
      FROM external_submissions es
      WHERE pir.external_submission_id = es.id
        AND pir.id = $1
      RETURNING
        pir.id,
        pir.external_submission_id,
        pir.org_id,
        pir.assessment_cycle_id,
        pir.submission_package_id,
        pir.status,
        pir.assigned_to_user_id,
        pir.assigned_at,
        pir.started_by_user_id,
        pir.started_at,
        pir.reviewed_by_user_id,
        pir.reviewed_at,
        pir.internal_notes,
        pir.created_at,
        pir.updated_at,
        es.status AS external_submission_status
      `,
      [input.intakeReviewId, input.reviewerUserId, input.assignedAt],
    );
    return result.rows[0] ?? null;
  }

  public async startReview(
    tx: PoolClient | undefined,
    input: StartReviewInput,
  ): Promise<IntakeReviewRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<IntakeReviewRecord>(
      `
      UPDATE pkcert_intake_reviews pir
      SET status = 'IN_INTAKE_REVIEW',
          assigned_to_user_id = CASE
            WHEN pir.assigned_to_user_id IS NULL AND $4::boolean THEN $2
            ELSE pir.assigned_to_user_id
          END,
          assigned_at = CASE
            WHEN pir.assigned_at IS NULL AND $4::boolean THEN $3
            ELSE pir.assigned_at
          END,
          started_by_user_id = $2,
          started_at = $3
      FROM external_submissions es
      WHERE pir.external_submission_id = es.id
        AND pir.id = $1
        AND pir.status = 'PENDING_INTAKE'
      RETURNING
        pir.id,
        pir.external_submission_id,
        pir.org_id,
        pir.assessment_cycle_id,
        pir.submission_package_id,
        pir.status,
        pir.assigned_to_user_id,
        pir.assigned_at,
        pir.started_by_user_id,
        pir.started_at,
        pir.reviewed_by_user_id,
        pir.reviewed_at,
        pir.internal_notes,
        pir.created_at,
        pir.updated_at,
        es.status AS external_submission_status
      `,
      [
        input.intakeReviewId,
        input.actorUserId,
        input.startedAt,
        input.assignToActorIfUnassigned,
      ],
    );
    return result.rows[0] ?? null;
  }

  public async markReviewed(
    tx: PoolClient | undefined,
    input: MarkReviewedInput,
  ): Promise<IntakeReviewRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<IntakeReviewRecord>(
      `
      UPDATE pkcert_intake_reviews pir
      SET status = 'INTAKE_REVIEWED',
          reviewed_by_user_id = $2,
          reviewed_at = $3
      FROM external_submissions es
      WHERE pir.external_submission_id = es.id
        AND pir.id = $1
        AND pir.status = 'IN_INTAKE_REVIEW'
      RETURNING
        pir.id,
        pir.external_submission_id,
        pir.org_id,
        pir.assessment_cycle_id,
        pir.submission_package_id,
        pir.status,
        pir.assigned_to_user_id,
        pir.assigned_at,
        pir.started_by_user_id,
        pir.started_at,
        pir.reviewed_by_user_id,
        pir.reviewed_at,
        pir.internal_notes,
        pir.created_at,
        pir.updated_at,
        es.status AS external_submission_status
      `,
      [input.intakeReviewId, input.actorUserId, input.reviewedAt],
    );
    return result.rows[0] ?? null;
  }

  public async updateNotes(
    tx: PoolClient | undefined,
    input: UpdateNotesInput,
  ): Promise<IntakeReviewRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<IntakeReviewRecord>(
      `
      UPDATE pkcert_intake_reviews pir
      SET internal_notes = $2
      FROM external_submissions es
      WHERE pir.external_submission_id = es.id
        AND pir.id = $1
      RETURNING
        pir.id,
        pir.external_submission_id,
        pir.org_id,
        pir.assessment_cycle_id,
        pir.submission_package_id,
        pir.status,
        pir.assigned_to_user_id,
        pir.assigned_at,
        pir.started_by_user_id,
        pir.started_at,
        pir.reviewed_by_user_id,
        pir.reviewed_at,
        pir.internal_notes,
        pir.created_at,
        pir.updated_at,
        es.status AS external_submission_status
      `,
      [input.intakeReviewId, input.internalNotes],
    );
    return result.rows[0] ?? null;
  }

  public async appendAuditEvent(
    tx: PoolClient | undefined,
    input: AppendPkcertIntakeAuditInput,
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
  CreateIntakeReviewInput,
  ExternalSubmissionStatus,
  IntakeReviewRecord,
  IntakeStatus,
  PkcertRole,
  PkcertUser,
};
