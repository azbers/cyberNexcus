import type { Pool, PoolClient } from "pg";

import { AUTH_ERRORS } from "../auth/errors.js";
import {
  AUDIT_EVENT_TYPES,
  AUDIT_SEVERITIES,
  type AuditEventType,
  type AuditSeverity,
} from "../auth/types.js";

type QueryExecutor = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export type CorrectionExecutionStatus = "CREATED" | "VOIDED";
export type CorrectionResubmissionStatus = "DRAFT" | "READY_FOR_RESUBMISSION" | "VOIDED";
export type AssessmentCycleStatus = "DRAFT" | "FINALIZED_INTERNAL" | "READY_FOR_SUBMISSION";
export type AssessmentCycleType = "NORMAL" | "CORRECTION";

type ActorProfile = {
  user_id: string;
  org_id: string;
  role: string;
};

export type CorrectionForExecution = {
  id: string;
  org_id: string;
  original_decision_id: string;
  original_assessment_cycle_id: string;
  status: CorrectionResubmissionStatus;
  decision: "ACCEPTED" | "REJECTED" | "RETURNED_FOR_CORRECTION";
};

export type AssessmentCycleForExecution = {
  id: string;
  org_id: string;
  status: AssessmentCycleStatus;
  cycle_type: AssessmentCycleType;
  source_correction_resubmission_id: string | null;
  source_assessment_cycle_id: string | null;
  created_by_user_id: string;
  finalized_internal_by_user_id: string | null;
  finalized_internal_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type CorrectionExecutionRecord = {
  id: string;
  org_id: string;
  correction_resubmission_id: string;
  original_assessment_cycle_id: string;
  correction_assessment_cycle_id: string;
  status: CorrectionExecutionStatus;
  created_by_user_id: string;
  created_at: Date;
  voided_by_user_id: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  updated_at: Date;
};

type InsertCorrectionAssessmentCycleInput = {
  orgId: string;
  sourceCorrectionResubmissionId: string;
  sourceAssessmentCycleId: string;
  createdByUserId: string;
};

type InsertExecutionInput = {
  orgId: string;
  correctionResubmissionId: string;
  originalAssessmentCycleId: string;
  correctionAssessmentCycleId: string;
  createdByUserId: string;
};

type VoidExecutionInput = {
  orgId: string;
  executionId: string;
  voidedByUserId: string;
  voidedAt: Date;
  voidReason: string;
};

type AppendCorrectionExecutionAuditInput = {
  eventType: "CORRECTION_EXECUTION_CYCLE_CREATED" | "CORRECTION_EXECUTION_CYCLE_VOIDED";
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

function validateAuditEvent(input: AppendCorrectionExecutionAuditInput): void {
  if (!AUDIT_EVENT_TYPES.includes(input.eventType as AuditEventType)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
  if (!AUDIT_SEVERITIES.includes(input.severity)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
}

export class CorrectionExecutionRepository {
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

  public async getCorrectionForUpdate(
    tx: PoolClient | undefined,
    orgId: string,
    correctionId: string,
  ): Promise<CorrectionForExecution | null> {
    const client = assertTx(tx);
    const result = await client.query<CorrectionForExecution>(
      `
      SELECT
        c.id,
        c.org_id,
        c.original_decision_id,
        c.original_assessment_cycle_id,
        c.status,
        d.decision
      FROM correction_resubmissions c
      JOIN pkcert_submission_decisions d
        ON d.id = c.original_decision_id
       AND d.org_id = c.org_id
      WHERE c.org_id = $1
        AND c.id = $2
      FOR UPDATE OF c
      `,
      [orgId, correctionId],
    );
    return result.rows[0] ?? null;
  }

  public async activeExecutionExistsForCorrection(
    tx: PoolClient | undefined,
    orgId: string,
    correctionId: string,
  ): Promise<boolean> {
    const client = assertTx(tx);
    const result = await client.query<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1
        FROM correction_execution_cycles
        WHERE org_id = $1
          AND correction_resubmission_id = $2
          AND status = 'CREATED'
      ) AS exists
      `,
      [orgId, correctionId],
    );
    return result.rows[0]?.exists ?? false;
  }

  public async insertCorrectionAssessmentCycle(
    tx: PoolClient | undefined,
    input: InsertCorrectionAssessmentCycleInput,
  ): Promise<AssessmentCycleForExecution> {
    const client = assertTx(tx);
    const result = await client.query<AssessmentCycleForExecution>(
      `
      INSERT INTO assessment_cycles (
        org_id,
        status,
        cycle_type,
        source_correction_resubmission_id,
        source_assessment_cycle_id,
        created_by_user_id
      )
      VALUES ($1, 'DRAFT', 'CORRECTION', $2, $3, $4)
      RETURNING
        id,
        org_id,
        status,
        cycle_type,
        source_correction_resubmission_id,
        source_assessment_cycle_id,
        created_by_user_id,
        finalized_internal_by_user_id,
        finalized_internal_at,
        created_at,
        updated_at
      `,
      [
        input.orgId,
        input.sourceCorrectionResubmissionId,
        input.sourceAssessmentCycleId,
        input.createdByUserId,
      ],
    );
    return result.rows[0];
  }

  public async cloneRequirementItems(
    tx: PoolClient | undefined,
    sourceCycleId: string,
    targetCycleId: string,
  ): Promise<number> {
    const client = assertTx(tx);
    const result = await client.query(
      `
      INSERT INTO assessment_requirement_items (
        assessment_cycle_id,
        pisf_requirement_id,
        requirement_key_snapshot,
        requirement_text_snapshot,
        source_hash_snapshot,
        assessment_status,
        updated_by_user_id
      )
      SELECT
        $2,
        pisf_requirement_id,
        requirement_key_snapshot,
        requirement_text_snapshot,
        source_hash_snapshot,
        'UNASSESSED',
        NULL
      FROM assessment_requirement_items
      WHERE assessment_cycle_id = $1
      ORDER BY requirement_key_snapshot ASC
      `,
      [sourceCycleId, targetCycleId],
    );
    return result.rowCount ?? 0;
  }

  public async insertExecution(
    tx: PoolClient | undefined,
    input: InsertExecutionInput,
  ): Promise<CorrectionExecutionRecord> {
    const client = assertTx(tx);
    const result = await client.query<CorrectionExecutionRecord>(
      `
      INSERT INTO correction_execution_cycles (
        org_id,
        correction_resubmission_id,
        original_assessment_cycle_id,
        correction_assessment_cycle_id,
        status,
        created_by_user_id
      )
      VALUES ($1, $2, $3, $4, 'CREATED', $5)
      RETURNING
        id,
        org_id,
        correction_resubmission_id,
        original_assessment_cycle_id,
        correction_assessment_cycle_id,
        status,
        created_by_user_id,
        created_at,
        voided_by_user_id,
        voided_at,
        void_reason,
        updated_at
      `,
      [
        input.orgId,
        input.correctionResubmissionId,
        input.originalAssessmentCycleId,
        input.correctionAssessmentCycleId,
        input.createdByUserId,
      ],
    );
    return result.rows[0];
  }

  public async getActiveExecutionByCorrection(
    orgId: string,
    correctionId: string,
    executor?: QueryExecutor,
  ): Promise<CorrectionExecutionRecord | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<CorrectionExecutionRecord>(
      `
      SELECT
        id,
        org_id,
        correction_resubmission_id,
        original_assessment_cycle_id,
        correction_assessment_cycle_id,
        status,
        created_by_user_id,
        created_at,
        voided_by_user_id,
        voided_at,
        void_reason,
        updated_at
      FROM correction_execution_cycles
      WHERE org_id = $1
        AND correction_resubmission_id = $2
        AND status = 'CREATED'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      `,
      [orgId, correctionId],
    );
    return result.rows[0] ?? null;
  }

  public async getExecutionById(
    orgId: string,
    executionId: string,
    executor?: QueryExecutor,
  ): Promise<CorrectionExecutionRecord | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<CorrectionExecutionRecord>(
      `
      SELECT
        id,
        org_id,
        correction_resubmission_id,
        original_assessment_cycle_id,
        correction_assessment_cycle_id,
        status,
        created_by_user_id,
        created_at,
        voided_by_user_id,
        voided_at,
        void_reason,
        updated_at
      FROM correction_execution_cycles
      WHERE org_id = $1
        AND id = $2
      `,
      [orgId, executionId],
    );
    return result.rows[0] ?? null;
  }

  public async getExecutionForUpdate(
    tx: PoolClient | undefined,
    orgId: string,
    executionId: string,
  ): Promise<CorrectionExecutionRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<CorrectionExecutionRecord>(
      `
      SELECT
        id,
        org_id,
        correction_resubmission_id,
        original_assessment_cycle_id,
        correction_assessment_cycle_id,
        status,
        created_by_user_id,
        created_at,
        voided_by_user_id,
        voided_at,
        void_reason,
        updated_at
      FROM correction_execution_cycles
      WHERE org_id = $1
        AND id = $2
      FOR UPDATE
      `,
      [orgId, executionId],
    );
    return result.rows[0] ?? null;
  }

  public async getAssessmentCycleForUpdate(
    tx: PoolClient | undefined,
    orgId: string,
    cycleId: string,
  ): Promise<AssessmentCycleForExecution | null> {
    const client = assertTx(tx);
    const result = await client.query<AssessmentCycleForExecution>(
      `
      SELECT
        id,
        org_id,
        status,
        cycle_type,
        source_correction_resubmission_id,
        source_assessment_cycle_id,
        created_by_user_id,
        finalized_internal_by_user_id,
        finalized_internal_at,
        created_at,
        updated_at
      FROM assessment_cycles
      WHERE org_id = $1
        AND id = $2
      FOR UPDATE
      `,
      [orgId, cycleId],
    );
    return result.rows[0] ?? null;
  }

  public async voidExecution(
    tx: PoolClient | undefined,
    input: VoidExecutionInput,
  ): Promise<CorrectionExecutionRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<CorrectionExecutionRecord>(
      `
      UPDATE correction_execution_cycles
      SET
        status = 'VOIDED',
        voided_by_user_id = $3,
        voided_at = $4,
        void_reason = $5
      WHERE org_id = $1
        AND id = $2
        AND status = 'CREATED'
      RETURNING
        id,
        org_id,
        correction_resubmission_id,
        original_assessment_cycle_id,
        correction_assessment_cycle_id,
        status,
        created_by_user_id,
        created_at,
        voided_by_user_id,
        voided_at,
        void_reason,
        updated_at
      `,
      [input.orgId, input.executionId, input.voidedByUserId, input.voidedAt, input.voidReason],
    );
    return result.rows[0] ?? null;
  }

  public async appendAuditEvent(
    tx: PoolClient | undefined,
    input: AppendCorrectionExecutionAuditInput,
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
