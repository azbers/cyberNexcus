import type { Pool, PoolClient } from "pg";

import { AUTH_ERRORS } from "../auth/errors.js";
import {
  AUDIT_EVENT_TYPES,
  AUDIT_SEVERITIES,
  type AuditEventType,
  type AuditSeverity,
} from "../auth/types.js";

type QueryExecutor = Pick<Pool, "query"> | Pick<PoolClient, "query">;

type AssessmentCycleStatus =
  | "DRAFT"
  | "FINALIZED_INTERNAL"
  | "READY_FOR_SUBMISSION";
type AssessmentCycleType = "NORMAL" | "CORRECTION";
type ScoreLabel =
  | "NON_COMPLIANT"
  | "PARTIALLY_COMPLIANT"
  | "SUBSTANTIALLY_COMPLIANT"
  | "COMPLIANT";

type ActorProfile = {
  user_id: string;
  org_id: string;
  role: string;
};

type AssessmentCycleRecord = {
  id: string;
  org_id: string;
  status: AssessmentCycleStatus;
  cycle_type: AssessmentCycleType;
  finalized_internal_at: Date | null;
};

type SubmissionReadinessRecord = {
  id: string;
  org_id: string;
  assessment_cycle_id: string;
  review_notes: string | null;
  confirmed_assessment_complete: boolean;
  confirmed_evidence_attached: boolean;
  confirmed_evidence_reviewed: boolean;
  confirmed_score_reviewed: boolean;
  confirmed_authorized_submitter: boolean;
  confirmed_information_accurate: boolean;
  declaration_text: string;
  declared_by_user_id: string;
  declared_at: Date;
  created_at: Date;
  updated_at: Date;
};

type ScoreSnapshotForReadiness = {
  id: string;
  assessment_cycle_id: string;
  org_id: string;
  overall_score: string | null;
  overall_label: ScoreLabel | null;
  calculated_at: Date | null;
};

type UpsertSubmissionReadinessInput = {
  orgId: string;
  assessmentCycleId: string;
  reviewNotes: string | null;
  confirmedAssessmentComplete: boolean;
  confirmedEvidenceAttached: boolean;
  confirmedEvidenceReviewed: boolean;
  confirmedScoreReviewed: boolean;
  confirmedAuthorizedSubmitter: boolean;
  confirmedInformationAccurate: boolean;
  declarationText: string;
  declaredByUserId: string;
  declaredAt: Date;
};

type MarkReadyInput = {
  cycleId: string;
};

type AppendSubmissionReadinessAuditInput = {
  eventType:
    | "SUBMISSION_READINESS_UPSERTED"
    | "ASSESSMENT_MARKED_READY_FOR_SUBMISSION";
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

function validateAuditEvent(input: AppendSubmissionReadinessAuditInput): void {
  if (!AUDIT_EVENT_TYPES.includes(input.eventType as AuditEventType)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
  if (!AUDIT_SEVERITIES.includes(input.severity)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
}

export class SubmissionReadinessRepository {
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

  public async getCycleByOrg(
    orgId: string,
    cycleId: string,
    executor?: QueryExecutor,
  ): Promise<AssessmentCycleRecord | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<AssessmentCycleRecord>(
      `
      SELECT id, org_id, status, cycle_type, finalized_internal_at
      FROM assessment_cycles
      WHERE org_id = $1
        AND id = $2
      `,
      [orgId, cycleId],
    );
    return result.rows[0] ?? null;
  }

  public async getCycleForUpdate(
    tx: PoolClient | undefined,
    orgId: string,
    cycleId: string,
  ): Promise<AssessmentCycleRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<AssessmentCycleRecord>(
      `
      SELECT id, org_id, status, cycle_type, finalized_internal_at
      FROM assessment_cycles
      WHERE org_id = $1
        AND id = $2
      FOR UPDATE
      `,
      [orgId, cycleId],
    );
    return result.rows[0] ?? null;
  }

  public async getReadinessByCycle(
    orgId: string,
    cycleId: string,
    executor?: QueryExecutor,
  ): Promise<SubmissionReadinessRecord | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<SubmissionReadinessRecord>(
      `
      SELECT
        r.id,
        r.org_id,
        r.assessment_cycle_id,
        r.review_notes,
        r.confirmed_assessment_complete,
        r.confirmed_evidence_attached,
        r.confirmed_evidence_reviewed,
        r.confirmed_score_reviewed,
        r.confirmed_authorized_submitter,
        r.confirmed_information_accurate,
        r.declaration_text,
        r.declared_by_user_id,
        r.declared_at,
        r.created_at,
        r.updated_at
      FROM assessment_submission_readiness r
      JOIN assessment_cycles c ON c.id = r.assessment_cycle_id
      WHERE r.org_id = $1
        AND r.assessment_cycle_id = $2
        AND c.org_id = r.org_id
      `,
      [orgId, cycleId],
    );
    return result.rows[0] ?? null;
  }

  public async upsertReadiness(
    tx: PoolClient | undefined,
    input: UpsertSubmissionReadinessInput,
  ): Promise<SubmissionReadinessRecord> {
    const client = assertTx(tx);
    const result = await client.query<SubmissionReadinessRecord>(
      `
      INSERT INTO assessment_submission_readiness (
        org_id,
        assessment_cycle_id,
        review_notes,
        confirmed_assessment_complete,
        confirmed_evidence_attached,
        confirmed_evidence_reviewed,
        confirmed_score_reviewed,
        confirmed_authorized_submitter,
        confirmed_information_accurate,
        declaration_text,
        declared_by_user_id,
        declared_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (assessment_cycle_id) DO UPDATE
      SET review_notes = EXCLUDED.review_notes,
          confirmed_assessment_complete = EXCLUDED.confirmed_assessment_complete,
          confirmed_evidence_attached = EXCLUDED.confirmed_evidence_attached,
          confirmed_evidence_reviewed = EXCLUDED.confirmed_evidence_reviewed,
          confirmed_score_reviewed = EXCLUDED.confirmed_score_reviewed,
          confirmed_authorized_submitter = EXCLUDED.confirmed_authorized_submitter,
          confirmed_information_accurate = EXCLUDED.confirmed_information_accurate,
          declaration_text = EXCLUDED.declaration_text,
          declared_by_user_id = EXCLUDED.declared_by_user_id,
          declared_at = EXCLUDED.declared_at
      RETURNING
        id,
        org_id,
        assessment_cycle_id,
        review_notes,
        confirmed_assessment_complete,
        confirmed_evidence_attached,
        confirmed_evidence_reviewed,
        confirmed_score_reviewed,
        confirmed_authorized_submitter,
        confirmed_information_accurate,
        declaration_text,
        declared_by_user_id,
        declared_at,
        created_at,
        updated_at
      `,
      [
        input.orgId,
        input.assessmentCycleId,
        input.reviewNotes,
        input.confirmedAssessmentComplete,
        input.confirmedEvidenceAttached,
        input.confirmedEvidenceReviewed,
        input.confirmedScoreReviewed,
        input.confirmedAuthorizedSubmitter,
        input.confirmedInformationAccurate,
        input.declarationText,
        input.declaredByUserId,
        input.declaredAt,
      ],
    );
    return result.rows[0];
  }

  public async getScoreSnapshotForCycle(
    tx: PoolClient | undefined,
    orgId: string,
    cycleId: string,
  ): Promise<ScoreSnapshotForReadiness | null> {
    const client = assertTx(tx);
    const result = await client.query<ScoreSnapshotForReadiness>(
      `
      SELECT
        id,
        assessment_cycle_id,
        org_id,
        overall_score,
        overall_label,
        calculated_at
      FROM assessment_score_snapshots
      WHERE org_id = $1
        AND assessment_cycle_id = $2
      `,
      [orgId, cycleId],
    );
    return result.rows[0] ?? null;
  }

  public async markReadyForSubmission(
    tx: PoolClient | undefined,
    input: MarkReadyInput,
  ): Promise<AssessmentCycleRecord> {
    const client = assertTx(tx);
    const result = await client.query<AssessmentCycleRecord>(
      `
      UPDATE assessment_cycles
      SET status = 'READY_FOR_SUBMISSION'
      WHERE id = $1
        AND status = 'FINALIZED_INTERNAL'
      RETURNING id, org_id, status, cycle_type, finalized_internal_at
      `,
      [input.cycleId],
    );
    return result.rows[0];
  }

  public async appendAuditEvent(
    tx: PoolClient | undefined,
    input: AppendSubmissionReadinessAuditInput,
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
  AssessmentCycleRecord,
  AssessmentCycleStatus,
  AssessmentCycleType,
  ScoreLabel,
  ScoreSnapshotForReadiness,
  SubmissionReadinessRecord,
  UpsertSubmissionReadinessInput,
};
