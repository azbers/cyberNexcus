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
type PkcertDecision = "ACCEPTED" | "REJECTED" | "RETURNED_FOR_CORRECTION";
type ExternalSubmissionStatus = "SUBMITTED" | "WITHDRAWN";
type IntakeStatus = "PENDING_INTAKE" | "IN_INTAKE_REVIEW" | "INTAKE_REVIEWED";

type PkcertUser = {
  user_id: string;
  org_id: string;
  pkcert_role: PkcertRole;
  is_active: boolean;
};

type ExternalSubmissionForDecision = {
  id: string;
  org_id: string;
  submission_package_id: string;
  assessment_cycle_id: string;
  status: ExternalSubmissionStatus;
};

type IntakeForDecision = {
  id: string;
  external_submission_id: string;
  org_id: string;
  assessment_cycle_id: string;
  submission_package_id: string;
  status: IntakeStatus;
  internal_notes: string | null;
};

type DecisionRecord = {
  id: string;
  external_submission_id: string;
  intake_review_id: string;
  org_id: string;
  assessment_cycle_id: string;
  submission_package_id: string;
  decision: PkcertDecision;
  decision_reason: string;
  decided_by_user_id: string;
  decided_at: Date;
  created_at: Date;
  updated_at: Date;
  intake_status?: IntakeStatus;
  internal_notes?: string | null;
};

type InsertDecisionInput = {
  externalSubmissionId: string;
  intakeReviewId: string;
  orgId: string;
  assessmentCycleId: string;
  submissionPackageId: string;
  decision: PkcertDecision;
  decisionReason: string;
  decidedByUserId: string;
  decidedAt: Date;
};

type AppendDecisionAuditInput = {
  eventType: "PKCERT_DECISION_RECORDED";
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

function validateAuditEvent(input: AppendDecisionAuditInput): void {
  if (!AUDIT_EVENT_TYPES.includes(input.eventType as AuditEventType)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
  if (!AUDIT_SEVERITIES.includes(input.severity)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
}

export class PkcertDecisionRepository {
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

  public async getExternalSubmissionForDecisionUpdate(
    tx: PoolClient | undefined,
    externalSubmissionId: string,
  ): Promise<ExternalSubmissionForDecision | null> {
    const client = assertTx(tx);
    const result = await client.query<ExternalSubmissionForDecision>(
      `
      SELECT
        id,
        org_id,
        submission_package_id,
        assessment_cycle_id,
        status
      FROM external_submissions
      WHERE id = $1
      FOR UPDATE
      `,
      [externalSubmissionId],
    );
    return result.rows[0] ?? null;
  }

  public async getIntakeForDecisionUpdate(
    tx: PoolClient | undefined,
    externalSubmissionId: string,
  ): Promise<IntakeForDecision | null> {
    const client = assertTx(tx);
    const result = await client.query<IntakeForDecision>(
      `
      SELECT
        id,
        external_submission_id,
        org_id,
        assessment_cycle_id,
        submission_package_id,
        status,
        internal_notes
      FROM pkcert_intake_reviews
      WHERE external_submission_id = $1
      FOR UPDATE
      `,
      [externalSubmissionId],
    );
    return result.rows[0] ?? null;
  }

  public async decisionExistsForSubmission(
    orgId: string,
    externalSubmissionId: string,
    executor?: QueryExecutor,
  ): Promise<boolean> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1
        FROM pkcert_submission_decisions
        WHERE org_id = $1
          AND external_submission_id = $2
      ) AS exists
      `,
      [orgId, externalSubmissionId],
    );
    return result.rows[0]?.exists ?? false;
  }

  public async insertDecision(
    tx: PoolClient | undefined,
    input: InsertDecisionInput,
  ): Promise<DecisionRecord> {
    const client = assertTx(tx);
    const result = await client.query<DecisionRecord>(
      `
      INSERT INTO pkcert_submission_decisions (
        external_submission_id,
        intake_review_id,
        org_id,
        assessment_cycle_id,
        submission_package_id,
        decision,
        decision_reason,
        decided_by_user_id,
        decided_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING
        id,
        external_submission_id,
        intake_review_id,
        org_id,
        assessment_cycle_id,
        submission_package_id,
        decision,
        decision_reason,
        decided_by_user_id,
        decided_at,
        created_at,
        updated_at
      `,
      [
        input.externalSubmissionId,
        input.intakeReviewId,
        input.orgId,
        input.assessmentCycleId,
        input.submissionPackageId,
        input.decision,
        input.decisionReason,
        input.decidedByUserId,
        input.decidedAt,
      ],
    );
    return result.rows[0];
  }

  public async getDecisionForPkcert(
    externalSubmissionId: string,
    executor?: QueryExecutor,
  ): Promise<DecisionRecord | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<DecisionRecord>(
      `
      SELECT
        d.id,
        d.external_submission_id,
        d.intake_review_id,
        d.org_id,
        d.assessment_cycle_id,
        d.submission_package_id,
        d.decision,
        d.decision_reason,
        d.decided_by_user_id,
        d.decided_at,
        d.created_at,
        d.updated_at,
        pir.status AS intake_status,
        pir.internal_notes
      FROM pkcert_submission_decisions d
      JOIN pkcert_intake_reviews pir ON pir.id = d.intake_review_id
      WHERE d.external_submission_id = $1
      `,
      [externalSubmissionId],
    );
    return result.rows[0] ?? null;
  }

  public async getDecisionForOrg(
    orgId: string,
    externalSubmissionId: string,
    executor?: QueryExecutor,
  ): Promise<DecisionRecord | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<DecisionRecord>(
      `
      SELECT
        id,
        external_submission_id,
        intake_review_id,
        org_id,
        assessment_cycle_id,
        submission_package_id,
        decision,
        decision_reason,
        decided_by_user_id,
        decided_at,
        created_at,
        updated_at
      FROM pkcert_submission_decisions
      WHERE org_id = $1
        AND external_submission_id = $2
      `,
      [orgId, externalSubmissionId],
    );
    return result.rows[0] ?? null;
  }

  public async appendAuditEvent(
    tx: PoolClient | undefined,
    input: AppendDecisionAuditInput,
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
  DecisionRecord,
  ExternalSubmissionForDecision,
  IntakeForDecision,
  PkcertDecision,
  PkcertRole,
  PkcertUser,
};
