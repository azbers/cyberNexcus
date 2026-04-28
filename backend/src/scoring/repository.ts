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
type AssessmentItemStatus =
  | "UNASSESSED"
  | "NOT_COMPLIANT"
  | "PARTIALLY_COMPLIANT"
  | "MOSTLY_COMPLIANT"
  | "FULLY_COMPLIANT"
  | "NOT_APPLICABLE";
type EvidenceQuality = "STRONG" | "MODERATE" | "WEAK" | "NONE";
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
};

type ScoringSourceRow = {
  assessment_requirement_item_id: string;
  pisf_requirement_id: string;
  pisf_control_id: string;
  assessment_status: AssessmentItemStatus;
  evidence_quality: EvidenceQuality | null;
};

type ScoreSnapshotRecord = {
  id: string;
  assessment_cycle_id: string;
  org_id: string;
  scoring_version: string;
  overall_score: string | null;
  overall_label: ScoreLabel | null;
  total_requirements: number;
  applicable_requirements: number;
  not_applicable_requirements: number;
  not_compliant_count: number;
  partially_compliant_count: number;
  mostly_compliant_count: number;
  fully_compliant_count: number;
  calculated_by_user_id: string | null;
  calculated_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type RequirementScoreInput = {
  scoreSnapshotId: string;
  assessmentRequirementItemId: string;
  pisfRequirementId: string;
  assessmentStatus: Exclude<AssessmentItemStatus, "UNASSESSED">;
  evidenceQuality: EvidenceQuality | null;
  statusScore: number | null;
  evidenceQualityCap: number | null;
  finalScore: number | null;
  excluded: boolean;
  exclusionReason: string | null;
};

type RequirementScoreRecord = {
  id: string;
  score_snapshot_id: string;
  assessment_requirement_item_id: string;
  pisf_requirement_id: string;
  assessment_status: Exclude<AssessmentItemStatus, "UNASSESSED">;
  evidence_quality: EvidenceQuality | null;
  status_score: string | null;
  evidence_quality_cap: string | null;
  final_score: string | null;
  excluded: boolean;
  exclusion_reason: string | null;
  created_at: Date;
};

type ControlScoreInput = {
  scoreSnapshotId: string;
  pisfControlId: string;
  controlScore: number | null;
  applicableRequirements: number;
  excludedRequirements: number;
  totalRequirements: number;
};

type ControlScoreRecord = {
  id: string;
  score_snapshot_id: string;
  pisf_control_id: string;
  control_score: string | null;
  applicable_requirements: number;
  excluded_requirements: number;
  total_requirements: number;
  created_at: Date;
};

type SnapshotSummaryInput = {
  snapshotId: string;
  overallScore: number | null;
  overallLabel: ScoreLabel | null;
  totalRequirements: number;
  applicableRequirements: number;
  notApplicableRequirements: number;
  notCompliantCount: number;
  partiallyCompliantCount: number;
  mostlyCompliantCount: number;
  fullyCompliantCount: number;
  calculatedByUserId: string;
  calculatedAt: Date;
};

type PaginatedResult<T> = {
  total: number;
  items: T[];
};

type AppendScoringAuditInput = {
  eventType: "ASSESSMENT_SCORE_CALCULATED";
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

function validateAuditEvent(input: AppendScoringAuditInput): void {
  if (!AUDIT_EVENT_TYPES.includes(input.eventType as AuditEventType)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
  if (!AUDIT_SEVERITIES.includes(input.severity)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
}

export class ScoringRepository {
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

  public async getCycleForScoringUpdate(
    tx: PoolClient | undefined,
    orgId: string,
    cycleId: string,
  ): Promise<AssessmentCycleRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<AssessmentCycleRecord>(
      `
      SELECT id, org_id, status, cycle_type
      FROM assessment_cycles
      WHERE org_id = $1
        AND id = $2
      FOR UPDATE
      `,
      [orgId, cycleId],
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
      SELECT id, org_id, status, cycle_type
      FROM assessment_cycles
      WHERE org_id = $1
        AND id = $2
      `,
      [orgId, cycleId],
    );
    return result.rows[0] ?? null;
  }

  public async countUnassessedItems(
    tx: PoolClient | undefined,
    cycleId: string,
  ): Promise<number> {
    const client = assertTx(tx);
    const result = await client.query<{ total: string }>(
      `
      SELECT count(*)::text AS total
      FROM assessment_requirement_items
      WHERE assessment_cycle_id = $1
        AND assessment_status = 'UNASSESSED'
      `,
      [cycleId],
    );
    return asNumber(result.rows[0]?.total ?? 0);
  }

  public async countMissingRequiredChecklists(
    tx: PoolClient | undefined,
    cycleId: string,
  ): Promise<number> {
    const client = assertTx(tx);
    const result = await client.query<{ total: string }>(
      `
      SELECT count(*)::text AS total
      FROM assessment_requirement_items i
      LEFT JOIN assessment_evidence_checklists c
        ON c.assessment_requirement_item_id = i.id
      WHERE i.assessment_cycle_id = $1
        AND i.assessment_status != 'NOT_APPLICABLE'
        AND c.id IS NULL
      `,
      [cycleId],
    );
    return asNumber(result.rows[0]?.total ?? 0);
  }

  public async listScoringSourceRows(
    tx: PoolClient | undefined,
    cycleId: string,
  ): Promise<ScoringSourceRow[]> {
    const client = assertTx(tx);
    const result = await client.query<ScoringSourceRow>(
      `
      SELECT
        i.id AS assessment_requirement_item_id,
        i.pisf_requirement_id,
        r.control_id AS pisf_control_id,
        i.assessment_status,
        c.evidence_quality
      FROM assessment_requirement_items i
      JOIN pisf_requirements r ON r.id = i.pisf_requirement_id
      LEFT JOIN assessment_evidence_checklists c
        ON c.assessment_requirement_item_id = i.id
      WHERE i.assessment_cycle_id = $1
      ORDER BY i.requirement_key_snapshot ASC
      `,
      [cycleId],
    );
    return result.rows;
  }

  public async upsertScoreSnapshot(
    tx: PoolClient | undefined,
    orgId: string,
    cycleId: string,
  ): Promise<ScoreSnapshotRecord> {
    const client = assertTx(tx);
    const result = await client.query<ScoreSnapshotRecord>(
      `
      INSERT INTO assessment_score_snapshots (
        assessment_cycle_id,
        org_id,
        scoring_version
      )
      VALUES ($1, $2, 'SCORING_V1')
      ON CONFLICT (assessment_cycle_id) DO UPDATE
      SET org_id = EXCLUDED.org_id,
          scoring_version = 'SCORING_V1'
      RETURNING
        id,
        assessment_cycle_id,
        org_id,
        scoring_version,
        overall_score,
        overall_label,
        total_requirements,
        applicable_requirements,
        not_applicable_requirements,
        not_compliant_count,
        partially_compliant_count,
        mostly_compliant_count,
        fully_compliant_count,
        calculated_by_user_id,
        calculated_at,
        created_at,
        updated_at
      `,
      [cycleId, orgId],
    );
    return result.rows[0];
  }

  public async clearRequirementScores(
    tx: PoolClient | undefined,
    snapshotId: string,
  ): Promise<void> {
    const client = assertTx(tx);
    await client.query(
      `
      DELETE FROM assessment_requirement_scores
      WHERE score_snapshot_id = $1
      `,
      [snapshotId],
    );
  }

  public async clearControlScores(
    tx: PoolClient | undefined,
    snapshotId: string,
  ): Promise<void> {
    const client = assertTx(tx);
    await client.query(
      `
      DELETE FROM assessment_control_scores
      WHERE score_snapshot_id = $1
      `,
      [snapshotId],
    );
  }

  public async insertRequirementScores(
    tx: PoolClient | undefined,
    rows: RequirementScoreInput[],
  ): Promise<void> {
    const client = assertTx(tx);
    for (const row of rows) {
      await client.query(
        `
        INSERT INTO assessment_requirement_scores (
          score_snapshot_id,
          assessment_requirement_item_id,
          pisf_requirement_id,
          assessment_status,
          evidence_quality,
          status_score,
          evidence_quality_cap,
          final_score,
          excluded,
          exclusion_reason
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          row.scoreSnapshotId,
          row.assessmentRequirementItemId,
          row.pisfRequirementId,
          row.assessmentStatus,
          row.evidenceQuality,
          row.statusScore,
          row.evidenceQualityCap,
          row.finalScore,
          row.excluded,
          row.exclusionReason,
        ],
      );
    }
  }

  public async insertControlScores(
    tx: PoolClient | undefined,
    rows: ControlScoreInput[],
  ): Promise<void> {
    const client = assertTx(tx);
    for (const row of rows) {
      await client.query(
        `
        INSERT INTO assessment_control_scores (
          score_snapshot_id,
          pisf_control_id,
          control_score,
          applicable_requirements,
          excluded_requirements,
          total_requirements
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          row.scoreSnapshotId,
          row.pisfControlId,
          row.controlScore,
          row.applicableRequirements,
          row.excludedRequirements,
          row.totalRequirements,
        ],
      );
    }
  }

  public async updateSnapshotSummary(
    tx: PoolClient | undefined,
    input: SnapshotSummaryInput,
  ): Promise<ScoreSnapshotRecord> {
    const client = assertTx(tx);
    const result = await client.query<ScoreSnapshotRecord>(
      `
      UPDATE assessment_score_snapshots
      SET overall_score = $2,
          overall_label = $3,
          total_requirements = $4,
          applicable_requirements = $5,
          not_applicable_requirements = $6,
          not_compliant_count = $7,
          partially_compliant_count = $8,
          mostly_compliant_count = $9,
          fully_compliant_count = $10,
          calculated_by_user_id = $11,
          calculated_at = $12
      WHERE id = $1
      RETURNING
        id,
        assessment_cycle_id,
        org_id,
        scoring_version,
        overall_score,
        overall_label,
        total_requirements,
        applicable_requirements,
        not_applicable_requirements,
        not_compliant_count,
        partially_compliant_count,
        mostly_compliant_count,
        fully_compliant_count,
        calculated_by_user_id,
        calculated_at,
        created_at,
        updated_at
      `,
      [
        input.snapshotId,
        input.overallScore,
        input.overallLabel,
        input.totalRequirements,
        input.applicableRequirements,
        input.notApplicableRequirements,
        input.notCompliantCount,
        input.partiallyCompliantCount,
        input.mostlyCompliantCount,
        input.fullyCompliantCount,
        input.calculatedByUserId,
        input.calculatedAt,
      ],
    );
    return result.rows[0];
  }

  public async appendAuditEvent(
    tx: PoolClient | undefined,
    input: AppendScoringAuditInput,
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

  public async getScoreSnapshot(
    orgId: string,
    cycleId: string,
    executor?: QueryExecutor,
  ): Promise<ScoreSnapshotRecord | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<ScoreSnapshotRecord>(
      `
      SELECT
        s.id,
        s.assessment_cycle_id,
        s.org_id,
        s.scoring_version,
        s.overall_score,
        s.overall_label,
        s.total_requirements,
        s.applicable_requirements,
        s.not_applicable_requirements,
        s.not_compliant_count,
        s.partially_compliant_count,
        s.mostly_compliant_count,
        s.fully_compliant_count,
        s.calculated_by_user_id,
        s.calculated_at,
        s.created_at,
        s.updated_at
      FROM assessment_score_snapshots s
      JOIN assessment_cycles c ON c.id = s.assessment_cycle_id
      WHERE s.org_id = $1
        AND s.assessment_cycle_id = $2
        AND c.org_id = s.org_id
      `,
      [orgId, cycleId],
    );
    return result.rows[0] ?? null;
  }

  public async listRequirementScores(
    snapshotId: string,
    limit: number,
    offset: number,
    executor?: QueryExecutor,
  ): Promise<PaginatedResult<RequirementScoreRecord>> {
    const db = executor ?? this.readExecutor;
    const total = await db.query<{ total: string }>(
      `
      SELECT count(*)::text AS total
      FROM assessment_requirement_scores
      WHERE score_snapshot_id = $1
      `,
      [snapshotId],
    );
    const result = await db.query<RequirementScoreRecord>(
      `
      SELECT
        id,
        score_snapshot_id,
        assessment_requirement_item_id,
        pisf_requirement_id,
        assessment_status,
        evidence_quality,
        status_score,
        evidence_quality_cap,
        final_score,
        excluded,
        exclusion_reason,
        created_at
      FROM assessment_requirement_scores
      WHERE score_snapshot_id = $1
      ORDER BY created_at ASC, id ASC
      LIMIT $2 OFFSET $3
      `,
      [snapshotId, limit, offset],
    );
    return { total: asNumber(total.rows[0]?.total ?? 0), items: result.rows };
  }

  public async listControlScores(
    snapshotId: string,
    limit: number,
    offset: number,
    executor?: QueryExecutor,
  ): Promise<PaginatedResult<ControlScoreRecord>> {
    const db = executor ?? this.readExecutor;
    const total = await db.query<{ total: string }>(
      `
      SELECT count(*)::text AS total
      FROM assessment_control_scores
      WHERE score_snapshot_id = $1
      `,
      [snapshotId],
    );
    const result = await db.query<ControlScoreRecord>(
      `
      SELECT
        id,
        score_snapshot_id,
        pisf_control_id,
        control_score,
        applicable_requirements,
        excluded_requirements,
        total_requirements,
        created_at
      FROM assessment_control_scores
      WHERE score_snapshot_id = $1
      ORDER BY created_at ASC, id ASC
      LIMIT $2 OFFSET $3
      `,
      [snapshotId, limit, offset],
    );
    return { total: asNumber(total.rows[0]?.total ?? 0), items: result.rows };
  }
}

export type {
  ActorProfile,
  AssessmentCycleRecord,
  AssessmentItemStatus,
  ControlScoreInput,
  ControlScoreRecord,
  EvidenceQuality,
  RequirementScoreInput,
  RequirementScoreRecord,
  ScoreLabel,
  ScoreSnapshotRecord,
  ScoringSourceRow,
};
