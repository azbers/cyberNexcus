import type { Pool, PoolClient } from "pg";

import { AUTH_ERRORS } from "../auth/errors.js";
import {
  AUDIT_EVENT_TYPES,
  AUDIT_SEVERITIES,
  type AuditEventType,
  type AuditSeverity,
} from "../auth/types.js";

type QueryExecutor = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export type CorrectionResubmissionStatus = "DRAFT" | "READY_FOR_RESUBMISSION" | "VOIDED";
type PkcertDecision = "ACCEPTED" | "REJECTED" | "RETURNED_FOR_CORRECTION";

export type ActorProfile = {
  user_id: string;
  org_id: string;
  role: string;
};

export type ExternalSubmissionDecisionContext = {
  external_submission_id: string;
  org_id: string;
  assessment_cycle_id: string;
  submission_package_id: string;
  decision_id: string | null;
  decision: PkcertDecision | null;
};

export type CorrectionResubmissionRecord = {
  id: string;
  org_id: string;
  original_external_submission_id: string;
  original_decision_id: string;
  original_submission_package_id: string;
  original_assessment_cycle_id: string;
  status: CorrectionResubmissionStatus;
  correction_reason: string;
  correction_summary: string | null;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
  ready_by_user_id: string | null;
  ready_at: Date | null;
  voided_by_user_id: string | null;
  voided_at: Date | null;
  void_reason: string | null;
};

export type InsertCorrectionInput = {
  orgId: string;
  originalExternalSubmissionId: string;
  originalDecisionId: string;
  originalSubmissionPackageId: string;
  originalAssessmentCycleId: string;
  correctionReason: string;
  createdByUserId: string;
};

export type UpdateSummaryInput = {
  orgId: string;
  correctionId: string;
  correctionSummary: string | null;
};

export type MarkReadyInput = {
  orgId: string;
  correctionId: string;
  readyByUserId: string;
  readyAt: Date;
};

export type VoidCorrectionInput = {
  orgId: string;
  correctionId: string;
  voidedByUserId: string;
  voidedAt: Date;
  voidReason: string;
};

type AppendCorrectionAuditInput = {
  eventType:
    | "CORRECTION_RESUBMISSION_CREATED"
    | "CORRECTION_RESUBMISSION_SUMMARY_UPDATED"
    | "CORRECTION_RESUBMISSION_MARKED_READY"
    | "CORRECTION_RESUBMISSION_VOIDED";
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

function validateAuditEvent(input: AppendCorrectionAuditInput): void {
  if (!AUDIT_EVENT_TYPES.includes(input.eventType as AuditEventType)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
  if (!AUDIT_SEVERITIES.includes(input.severity)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
}

export class CorrectionResubmissionRepository {
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

  public async getExternalSubmissionDecisionContext(
    orgId: string,
    externalSubmissionId: string,
    executor?: QueryExecutor,
  ): Promise<ExternalSubmissionDecisionContext | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<ExternalSubmissionDecisionContext>(
      `
      SELECT
        es.id AS external_submission_id,
        es.org_id,
        es.assessment_cycle_id,
        es.submission_package_id,
        d.id AS decision_id,
        d.decision
      FROM external_submissions es
      LEFT JOIN pkcert_submission_decisions d
        ON d.external_submission_id = es.id
       AND d.org_id = es.org_id
      WHERE es.org_id = $1
        AND es.id = $2
      `,
      [orgId, externalSubmissionId],
    );
    return result.rows[0] ?? null;
  }

  public async activeCorrectionExistsForDecision(
    orgId: string,
    decisionId: string,
    executor?: QueryExecutor,
  ): Promise<boolean> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1
        FROM correction_resubmissions
        WHERE org_id = $1
          AND original_decision_id = $2
          AND status IN ('DRAFT', 'READY_FOR_RESUBMISSION')
      ) AS exists
      `,
      [orgId, decisionId],
    );
    return result.rows[0]?.exists ?? false;
  }

  public async insertCorrection(
    tx: PoolClient | undefined,
    input: InsertCorrectionInput,
  ): Promise<CorrectionResubmissionRecord> {
    const client = assertTx(tx);
    const result = await client.query<CorrectionResubmissionRecord>(
      `
      INSERT INTO correction_resubmissions (
        org_id,
        original_external_submission_id,
        original_decision_id,
        original_submission_package_id,
        original_assessment_cycle_id,
        status,
        correction_reason,
        created_by_user_id
      )
      VALUES ($1, $2, $3, $4, $5, 'DRAFT', $6, $7)
      RETURNING
        id,
        org_id,
        original_external_submission_id,
        original_decision_id,
        original_submission_package_id,
        original_assessment_cycle_id,
        status,
        correction_reason,
        correction_summary,
        created_by_user_id,
        created_at,
        updated_at,
        ready_by_user_id,
        ready_at,
        voided_by_user_id,
        voided_at,
        void_reason
      `,
      [
        input.orgId,
        input.originalExternalSubmissionId,
        input.originalDecisionId,
        input.originalSubmissionPackageId,
        input.originalAssessmentCycleId,
        input.correctionReason,
        input.createdByUserId,
      ],
    );
    return result.rows[0];
  }

  public async getCorrectionById(
    orgId: string,
    correctionId: string,
    executor?: QueryExecutor,
  ): Promise<CorrectionResubmissionRecord | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<CorrectionResubmissionRecord>(
      `
      SELECT
        id,
        org_id,
        original_external_submission_id,
        original_decision_id,
        original_submission_package_id,
        original_assessment_cycle_id,
        status,
        correction_reason,
        correction_summary,
        created_by_user_id,
        created_at,
        updated_at,
        ready_by_user_id,
        ready_at,
        voided_by_user_id,
        voided_at,
        void_reason
      FROM correction_resubmissions
      WHERE org_id = $1
        AND id = $2
      `,
      [orgId, correctionId],
    );
    return result.rows[0] ?? null;
  }

  public async getCorrectionForUpdate(
    tx: PoolClient | undefined,
    orgId: string,
    correctionId: string,
  ): Promise<CorrectionResubmissionRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<CorrectionResubmissionRecord>(
      `
      SELECT
        id,
        org_id,
        original_external_submission_id,
        original_decision_id,
        original_submission_package_id,
        original_assessment_cycle_id,
        status,
        correction_reason,
        correction_summary,
        created_by_user_id,
        created_at,
        updated_at,
        ready_by_user_id,
        ready_at,
        voided_by_user_id,
        voided_at,
        void_reason
      FROM correction_resubmissions
      WHERE org_id = $1
        AND id = $2
      FOR UPDATE
      `,
      [orgId, correctionId],
    );
    return result.rows[0] ?? null;
  }

  public async listCorrectionsForSubmission(
    orgId: string,
    externalSubmissionId: string,
    executor?: QueryExecutor,
  ): Promise<CorrectionResubmissionRecord[]> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<CorrectionResubmissionRecord>(
      `
      SELECT
        id,
        org_id,
        original_external_submission_id,
        original_decision_id,
        original_submission_package_id,
        original_assessment_cycle_id,
        status,
        correction_reason,
        correction_summary,
        created_by_user_id,
        created_at,
        updated_at,
        ready_by_user_id,
        ready_at,
        voided_by_user_id,
        voided_at,
        void_reason
      FROM correction_resubmissions
      WHERE org_id = $1
        AND original_external_submission_id = $2
      ORDER BY created_at DESC, id DESC
      `,
      [orgId, externalSubmissionId],
    );
    return result.rows;
  }

  public async updateSummary(
    tx: PoolClient | undefined,
    input: UpdateSummaryInput,
  ): Promise<CorrectionResubmissionRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<CorrectionResubmissionRecord>(
      `
      UPDATE correction_resubmissions
      SET correction_summary = $3
      WHERE org_id = $1
        AND id = $2
      RETURNING
        id,
        org_id,
        original_external_submission_id,
        original_decision_id,
        original_submission_package_id,
        original_assessment_cycle_id,
        status,
        correction_reason,
        correction_summary,
        created_by_user_id,
        created_at,
        updated_at,
        ready_by_user_id,
        ready_at,
        voided_by_user_id,
        voided_at,
        void_reason
      `,
      [input.orgId, input.correctionId, input.correctionSummary],
    );
    return result.rows[0] ?? null;
  }

  public async markReady(
    tx: PoolClient | undefined,
    input: MarkReadyInput,
  ): Promise<CorrectionResubmissionRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<CorrectionResubmissionRecord>(
      `
      UPDATE correction_resubmissions
      SET
        status = 'READY_FOR_RESUBMISSION',
        ready_by_user_id = $3,
        ready_at = $4
      WHERE org_id = $1
        AND id = $2
      RETURNING
        id,
        org_id,
        original_external_submission_id,
        original_decision_id,
        original_submission_package_id,
        original_assessment_cycle_id,
        status,
        correction_reason,
        correction_summary,
        created_by_user_id,
        created_at,
        updated_at,
        ready_by_user_id,
        ready_at,
        voided_by_user_id,
        voided_at,
        void_reason
      `,
      [input.orgId, input.correctionId, input.readyByUserId, input.readyAt],
    );
    return result.rows[0] ?? null;
  }

  public async voidCorrection(
    tx: PoolClient | undefined,
    input: VoidCorrectionInput,
  ): Promise<CorrectionResubmissionRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<CorrectionResubmissionRecord>(
      `
      UPDATE correction_resubmissions
      SET
        status = 'VOIDED',
        voided_by_user_id = $3,
        voided_at = $4,
        void_reason = $5
      WHERE org_id = $1
        AND id = $2
      RETURNING
        id,
        org_id,
        original_external_submission_id,
        original_decision_id,
        original_submission_package_id,
        original_assessment_cycle_id,
        status,
        correction_reason,
        correction_summary,
        created_by_user_id,
        created_at,
        updated_at,
        ready_by_user_id,
        ready_at,
        voided_by_user_id,
        voided_at,
        void_reason
      `,
      [input.orgId, input.correctionId, input.voidedByUserId, input.voidedAt, input.voidReason],
    );
    return result.rows[0] ?? null;
  }

  public async appendAuditEvent(
    tx: PoolClient | undefined,
    input: AppendCorrectionAuditInput,
  ): Promise<void> {
    const client = assertTx(tx);
    validateAuditEvent(input);
    await client.query(
      `
      INSERT INTO auth_audit_logs (
        event_type,
        severity,
        user_id,
        org_id,
        ip_address,
        user_agent,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
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
