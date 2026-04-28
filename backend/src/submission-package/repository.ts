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
type PackageStatus = "CREATED" | "VOIDED";
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

type AssessmentCycleForPackage = {
  id: string;
  org_id: string;
  status: AssessmentCycleStatus;
  cycle_type: AssessmentCycleType;
  finalized_internal_at: Date | null;
};

type ReadinessForPackage = {
  id: string;
  org_id: string;
  assessment_cycle_id: string;
};

type ScoreSnapshotForPackage = {
  id: string;
  assessment_cycle_id: string;
  org_id: string;
  scoring_version: string;
  overall_score: string | null;
  overall_label: ScoreLabel | null;
  total_requirements: number;
  applicable_requirements: number;
  not_applicable_requirements: number;
  calculated_at: Date | null;
};

type PackageManifestCounts = {
  evidence_files: number;
  checklists: number;
};

type SubmissionPackageRecord = {
  id: string;
  org_id: string;
  assessment_cycle_id: string;
  score_snapshot_id: string;
  readiness_id: string;
  package_number: string;
  status: PackageStatus;
  manifest_json: Record<string, unknown>;
  manifest_hash: string;
  created_by_user_id: string;
  created_at: Date;
  voided_by_user_id: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  updated_at: Date;
};

type InsertSubmissionPackageInput = {
  orgId: string;
  assessmentCycleId: string;
  scoreSnapshotId: string;
  readinessId: string;
  packageNumber: string;
  manifestJson: Record<string, unknown>;
  manifestHash: string;
  createdByUserId: string;
  createdAt: Date;
};

type VoidSubmissionPackageInput = {
  orgId: string;
  packageId: string;
  voidedByUserId: string;
  voidedAt: Date;
  voidReason: string;
};

type AppendSubmissionPackageAuditInput = {
  eventType: "SUBMISSION_PACKAGE_CREATED" | "SUBMISSION_PACKAGE_VOIDED";
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

function validateAuditEvent(input: AppendSubmissionPackageAuditInput): void {
  if (!AUDIT_EVENT_TYPES.includes(input.eventType as AuditEventType)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
  if (!AUDIT_SEVERITIES.includes(input.severity)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
}

export class SubmissionPackageRepository {
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

  public async getCycleForPackageUpdate(
    tx: PoolClient | undefined,
    orgId: string,
    cycleId: string,
  ): Promise<AssessmentCycleForPackage | null> {
    const client = assertTx(tx);
    const result = await client.query<AssessmentCycleForPackage>(
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

  public async getReadinessForCycle(
    tx: PoolClient | undefined,
    orgId: string,
    cycleId: string,
  ): Promise<ReadinessForPackage | null> {
    const client = assertTx(tx);
    const result = await client.query<ReadinessForPackage>(
      `
      SELECT id, org_id, assessment_cycle_id
      FROM assessment_submission_readiness
      WHERE org_id = $1
        AND assessment_cycle_id = $2
      `,
      [orgId, cycleId],
    );
    return result.rows[0] ?? null;
  }

  public async getScoreSnapshotForCycle(
    tx: PoolClient | undefined,
    orgId: string,
    cycleId: string,
  ): Promise<ScoreSnapshotForPackage | null> {
    const client = assertTx(tx);
    const result = await client.query<ScoreSnapshotForPackage>(
      `
      SELECT
        id,
        assessment_cycle_id,
        org_id,
        scoring_version,
        overall_score,
        overall_label,
        total_requirements,
        applicable_requirements,
        not_applicable_requirements,
        calculated_at
      FROM assessment_score_snapshots
      WHERE org_id = $1
        AND assessment_cycle_id = $2
      `,
      [orgId, cycleId],
    );
    return result.rows[0] ?? null;
  }

  public async getManifestCounts(
    tx: PoolClient | undefined,
    cycleId: string,
  ): Promise<PackageManifestCounts> {
    const client = assertTx(tx);
    const result = await client.query<{
      evidence_files: string;
      checklists: string;
    }>(
      `
      SELECT
        (
          SELECT count(*)::text
          FROM assessment_evidence_files
          WHERE assessment_cycle_id = $1
            AND status = 'UPLOADED'
        ) AS evidence_files,
        (
          SELECT count(*)::text
          FROM assessment_evidence_checklists
          WHERE assessment_cycle_id = $1
        ) AS checklists
      `,
      [cycleId],
    );
    return {
      evidence_files: asNumber(result.rows[0]?.evidence_files ?? 0),
      checklists: asNumber(result.rows[0]?.checklists ?? 0),
    };
  }

  public async getActivePackageByCycle(
    orgId: string,
    cycleId: string,
    executor?: QueryExecutor,
  ): Promise<SubmissionPackageRecord | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<SubmissionPackageRecord>(
      `
      SELECT
        id,
        org_id,
        assessment_cycle_id,
        score_snapshot_id,
        readiness_id,
        package_number,
        status,
        manifest_json,
        manifest_hash,
        created_by_user_id,
        created_at,
        voided_by_user_id,
        voided_at,
        void_reason,
        updated_at
      FROM assessment_submission_packages
      WHERE org_id = $1
        AND assessment_cycle_id = $2
        AND status = 'CREATED'
      `,
      [orgId, cycleId],
    );
    return result.rows[0] ?? null;
  }

  public async getPackageById(
    orgId: string,
    packageId: string,
    executor?: QueryExecutor,
  ): Promise<SubmissionPackageRecord | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<SubmissionPackageRecord>(
      `
      SELECT
        id,
        org_id,
        assessment_cycle_id,
        score_snapshot_id,
        readiness_id,
        package_number,
        status,
        manifest_json,
        manifest_hash,
        created_by_user_id,
        created_at,
        voided_by_user_id,
        voided_at,
        void_reason,
        updated_at
      FROM assessment_submission_packages
      WHERE org_id = $1
        AND id = $2
      `,
      [orgId, packageId],
    );
    return result.rows[0] ?? null;
  }

  public async getPackageForUpdate(
    tx: PoolClient | undefined,
    orgId: string,
    packageId: string,
  ): Promise<SubmissionPackageRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<SubmissionPackageRecord>(
      `
      SELECT
        id,
        org_id,
        assessment_cycle_id,
        score_snapshot_id,
        readiness_id,
        package_number,
        status,
        manifest_json,
        manifest_hash,
        created_by_user_id,
        created_at,
        voided_by_user_id,
        voided_at,
        void_reason,
        updated_at
      FROM assessment_submission_packages
      WHERE org_id = $1
        AND id = $2
      FOR UPDATE
      `,
      [orgId, packageId],
    );
    return result.rows[0] ?? null;
  }

  public async hasActiveExternalSubmission(
    tx: PoolClient | undefined,
    orgId: string,
    packageId: string,
  ): Promise<boolean> {
    const client = assertTx(tx);
    const result = await client.query<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1
        FROM external_submissions
        WHERE org_id = $1
          AND submission_package_id = $2
          AND status = 'SUBMITTED'
      ) AS exists
      `,
      [orgId, packageId],
    );
    return result.rows[0]?.exists ?? false;
  }

  public async insertPackage(
    tx: PoolClient | undefined,
    input: InsertSubmissionPackageInput,
  ): Promise<SubmissionPackageRecord> {
    const client = assertTx(tx);
    const result = await client.query<SubmissionPackageRecord>(
      `
      INSERT INTO assessment_submission_packages (
        org_id,
        assessment_cycle_id,
        score_snapshot_id,
        readiness_id,
        package_number,
        status,
        manifest_json,
        manifest_hash,
        created_by_user_id,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, 'CREATED', $6::jsonb, $7, $8, $9)
      RETURNING
        id,
        org_id,
        assessment_cycle_id,
        score_snapshot_id,
        readiness_id,
        package_number,
        status,
        manifest_json,
        manifest_hash,
        created_by_user_id,
        created_at,
        voided_by_user_id,
        voided_at,
        void_reason,
        updated_at
      `,
      [
        input.orgId,
        input.assessmentCycleId,
        input.scoreSnapshotId,
        input.readinessId,
        input.packageNumber,
        JSON.stringify(input.manifestJson),
        input.manifestHash,
        input.createdByUserId,
        input.createdAt,
      ],
    );
    return result.rows[0];
  }

  public async voidPackage(
    tx: PoolClient | undefined,
    input: VoidSubmissionPackageInput,
  ): Promise<SubmissionPackageRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<SubmissionPackageRecord>(
      `
      UPDATE assessment_submission_packages
      SET status = 'VOIDED',
          voided_by_user_id = $3,
          voided_at = $4,
          void_reason = $5
      WHERE org_id = $1
        AND id = $2
        AND status = 'CREATED'
      RETURNING
        id,
        org_id,
        assessment_cycle_id,
        score_snapshot_id,
        readiness_id,
        package_number,
        status,
        manifest_json,
        manifest_hash,
        created_by_user_id,
        created_at,
        voided_by_user_id,
        voided_at,
        void_reason,
        updated_at
      `,
      [
        input.orgId,
        input.packageId,
        input.voidedByUserId,
        input.voidedAt,
        input.voidReason,
      ],
    );
    return result.rows[0] ?? null;
  }

  public async appendAuditEvent(
    tx: PoolClient | undefined,
    input: AppendSubmissionPackageAuditInput,
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
  AssessmentCycleForPackage,
  AssessmentCycleStatus,
  AssessmentCycleType,
  InsertSubmissionPackageInput,
  PackageManifestCounts,
  PackageStatus,
  ReadinessForPackage,
  ScoreLabel,
  ScoreSnapshotForPackage,
  SubmissionPackageRecord,
};
