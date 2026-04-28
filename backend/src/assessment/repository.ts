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
type ChecklistYesNoNa = "YES" | "NO" | "NOT_APPLICABLE";
type ChecklistYesNo = "YES" | "NO";
type ChecklistAddressAnswer = "YES" | "PARTIALLY" | "NO";
type ChecklistApprovalAnswer = "YES" | "PENDING" | "NO" | "NOT_APPLICABLE";
type EvidenceQuality = "STRONG" | "MODERATE" | "WEAK" | "NONE";

type AssessmentCycleRecord = {
  id: string;
  org_id: string;
  status: AssessmentCycleStatus;
  cycle_type: AssessmentCycleType;
  source_correction_resubmission_id: string | null;
  source_assessment_cycle_id: string | null;
  created_by_user_id: string;
  finalized_internal_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  finalized_internal_at: Date | null;
};

type AssessmentItemRecord = {
  id: string;
  assessment_cycle_id: string;
  pisf_requirement_id: string;
  requirement_key_snapshot: string;
  requirement_text_snapshot: string;
  source_hash_snapshot: string;
  assessment_status: AssessmentItemStatus;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type AssessmentEvidenceChecklistRecord = {
  id: string;
  org_id: string;
  assessment_cycle_id: string;
  assessment_requirement_item_id: string;
  dated_within_12_months: ChecklistYesNoNa;
  organization_specific: ChecklistYesNo;
  addresses_requirement: ChecklistAddressAnswer;
  approved_by_authority: ChecklistApprovalAnswer;
  currently_in_force: ChecklistYesNoNa;
  evidence_quality: EvidenceQuality;
  review_notes: string | null;
  reviewed_by_user_id: string;
  reviewed_at: Date;
  created_at: Date;
  updated_at: Date;
};

type ListCyclesInput = {
  limit: number;
  offset: number;
  status: AssessmentCycleStatus | null;
};

type ListItemsInput = {
  limit: number;
  offset: number;
  status: AssessmentItemStatus | null;
};

type PaginatedResult<T> = {
  total: number;
  items: T[];
};

type ActorProfile = {
  user_id: string;
  org_id: string;
  role: string;
};

type CreateCycleInput = {
  orgId: string;
  createdByUserId: string;
};

type UpdateItemStatusInput = {
  itemId: string;
  status: AssessmentItemStatus;
  updatedByUserId: string;
};

type UpsertEvidenceChecklistInput = {
  orgId: string;
  assessmentCycleId: string;
  assessmentRequirementItemId: string;
  datedWithin12Months: ChecklistYesNoNa;
  organizationSpecific: ChecklistYesNo;
  addressesRequirement: ChecklistAddressAnswer;
  approvedByAuthority: ChecklistApprovalAnswer;
  currentlyInForce: ChecklistYesNoNa;
  evidenceQuality: EvidenceQuality;
  reviewNotes: string | null;
  reviewedByUserId: string;
  reviewedAt: Date;
};

type AppendAssessmentAuditInput = {
  eventType:
    | "ASSESSMENT_DRAFT_CREATED"
    | "ASSESSMENT_ITEM_STATUS_UPDATED"
    | "ASSESSMENT_INTERNAL_FINALIZED"
    | "EVIDENCE_CHECKLIST_UPSERTED";
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

function validateAuditEvent(input: AppendAssessmentAuditInput): void {
  if (!AUDIT_EVENT_TYPES.includes(input.eventType as AuditEventType)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
  if (!AUDIT_SEVERITIES.includes(input.severity)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
}

export class AssessmentRepository {
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

  public async findDraftCycleForOrg(
    tx: PoolClient | undefined,
    orgId: string,
  ): Promise<AssessmentCycleRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<AssessmentCycleRecord>(
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
        created_at,
        updated_at,
        finalized_internal_at
      FROM assessment_cycles
      WHERE org_id = $1
        AND status = 'DRAFT'
        AND cycle_type = 'NORMAL'
      FOR UPDATE
      `,
      [orgId],
    );
    return result.rows[0] ?? null;
  }

  public async createDraftCycle(
    tx: PoolClient | undefined,
    input: CreateCycleInput,
  ): Promise<AssessmentCycleRecord> {
    const client = assertTx(tx);
    const result = await client.query<AssessmentCycleRecord>(
      `
      INSERT INTO assessment_cycles (
        org_id,
        status,
        created_by_user_id
      )
      VALUES ($1, 'DRAFT', $2)
      RETURNING
        id,
        org_id,
        status,
        cycle_type,
        source_correction_resubmission_id,
        source_assessment_cycle_id,
        created_by_user_id,
        finalized_internal_by_user_id,
        created_at,
        updated_at,
        finalized_internal_at
      `,
      [input.orgId, input.createdByUserId],
    );
    return result.rows[0];
  }

  public async seedItemsFromActiveRequirements(
    tx: PoolClient | undefined,
    cycleId: string,
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
        assessment_status
      )
      SELECT
        $1,
        r.id,
        r.requirement_key,
        r.requirement_text,
        r.source_hash,
        'UNASSESSED'
      FROM pisf_requirements r
      JOIN pisf_controls c ON c.id = r.control_id
      JOIN pisf_domains d ON d.id = c.domain_id
      WHERE r.is_active = TRUE
        AND r.status = 'ACTIVE'
        AND c.is_active = TRUE
        AND d.is_active = TRUE
      ON CONFLICT (assessment_cycle_id, pisf_requirement_id) DO NOTHING
      `,
      [cycleId],
    );
    return result.rowCount ?? 0;
  }

  public async getCycleForUpdate(
    tx: PoolClient | undefined,
    orgId: string,
    cycleId: string,
  ): Promise<AssessmentCycleRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<AssessmentCycleRecord>(
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
        created_at,
        updated_at,
        finalized_internal_at
      FROM assessment_cycles
      WHERE org_id = $1
        AND id = $2
      FOR UPDATE
      `,
      [orgId, cycleId],
    );
    return result.rows[0] ?? null;
  }

  public async getItemForUpdate(
    tx: PoolClient | undefined,
    cycleId: string,
    itemId: string,
  ): Promise<AssessmentItemRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<AssessmentItemRecord>(
      `
      SELECT
        id,
        assessment_cycle_id,
        pisf_requirement_id,
        requirement_key_snapshot,
        requirement_text_snapshot,
        source_hash_snapshot,
        assessment_status,
        updated_by_user_id,
        created_at,
        updated_at
      FROM assessment_requirement_items
      WHERE assessment_cycle_id = $1
        AND id = $2
      FOR UPDATE
      `,
      [cycleId, itemId],
    );
    return result.rows[0] ?? null;
  }

  public async updateItemStatus(
    tx: PoolClient | undefined,
    input: UpdateItemStatusInput,
  ): Promise<AssessmentItemRecord> {
    const client = assertTx(tx);
    const result = await client.query<AssessmentItemRecord>(
      `
      UPDATE assessment_requirement_items
      SET assessment_status = $2,
          updated_by_user_id = $3
      WHERE id = $1
      RETURNING
        id,
        assessment_cycle_id,
        pisf_requirement_id,
        requirement_key_snapshot,
        requirement_text_snapshot,
        source_hash_snapshot,
        assessment_status,
        updated_by_user_id,
        created_at,
        updated_at
      `,
      [input.itemId, input.status, input.updatedByUserId],
    );
    return result.rows[0];
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

  public async countItemsMissingRequiredEvidenceChecklist(
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

  public async finalizeInternalCycle(
    tx: PoolClient | undefined,
    cycleId: string,
    finalizedByUserId: string,
    finalizedAt: Date,
  ): Promise<AssessmentCycleRecord> {
    const client = assertTx(tx);
    const result = await client.query<AssessmentCycleRecord>(
      `
      UPDATE assessment_cycles
      SET status = 'FINALIZED_INTERNAL',
          finalized_internal_by_user_id = $2,
          finalized_internal_at = $3
      WHERE id = $1
        AND status = 'DRAFT'
      RETURNING
        id,
        org_id,
        status,
        cycle_type,
        source_correction_resubmission_id,
        source_assessment_cycle_id,
        created_by_user_id,
        finalized_internal_by_user_id,
        created_at,
        updated_at,
        finalized_internal_at
      `,
      [cycleId, finalizedByUserId, finalizedAt],
    );
    return result.rows[0];
  }

  public async appendAuditEvent(
    tx: PoolClient | undefined,
    input: AppendAssessmentAuditInput,
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

  public async getEvidenceChecklistByItem(
    orgId: string,
    cycleId: string,
    itemId: string,
    executor?: QueryExecutor,
  ): Promise<AssessmentEvidenceChecklistRecord | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<AssessmentEvidenceChecklistRecord>(
      `
      SELECT
        c.id,
        c.org_id,
        c.assessment_cycle_id,
        c.assessment_requirement_item_id,
        c.dated_within_12_months,
        c.organization_specific,
        c.addresses_requirement,
        c.approved_by_authority,
        c.currently_in_force,
        c.evidence_quality,
        c.review_notes,
        c.reviewed_by_user_id,
        c.reviewed_at,
        c.created_at,
        c.updated_at
      FROM assessment_evidence_checklists c
      JOIN assessment_cycles ac ON ac.id = c.assessment_cycle_id
      JOIN assessment_requirement_items i ON i.id = c.assessment_requirement_item_id
      WHERE c.org_id = $1
        AND c.assessment_cycle_id = $2
        AND c.assessment_requirement_item_id = $3
        AND ac.org_id = c.org_id
        AND i.assessment_cycle_id = ac.id
      `,
      [orgId, cycleId, itemId],
    );
    return result.rows[0] ?? null;
  }

  public async upsertEvidenceChecklist(
    tx: PoolClient | undefined,
    input: UpsertEvidenceChecklistInput,
  ): Promise<AssessmentEvidenceChecklistRecord> {
    const client = assertTx(tx);
    const result = await client.query<AssessmentEvidenceChecklistRecord>(
      `
      INSERT INTO assessment_evidence_checklists (
        org_id,
        assessment_cycle_id,
        assessment_requirement_item_id,
        dated_within_12_months,
        organization_specific,
        addresses_requirement,
        approved_by_authority,
        currently_in_force,
        evidence_quality,
        review_notes,
        reviewed_by_user_id,
        reviewed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (assessment_requirement_item_id) DO UPDATE
      SET dated_within_12_months = EXCLUDED.dated_within_12_months,
          organization_specific = EXCLUDED.organization_specific,
          addresses_requirement = EXCLUDED.addresses_requirement,
          approved_by_authority = EXCLUDED.approved_by_authority,
          currently_in_force = EXCLUDED.currently_in_force,
          evidence_quality = EXCLUDED.evidence_quality,
          review_notes = EXCLUDED.review_notes,
          reviewed_by_user_id = EXCLUDED.reviewed_by_user_id,
          reviewed_at = EXCLUDED.reviewed_at
      RETURNING
        id,
        org_id,
        assessment_cycle_id,
        assessment_requirement_item_id,
        dated_within_12_months,
        organization_specific,
        addresses_requirement,
        approved_by_authority,
        currently_in_force,
        evidence_quality,
        review_notes,
        reviewed_by_user_id,
        reviewed_at,
        created_at,
        updated_at
      `,
      [
        input.orgId,
        input.assessmentCycleId,
        input.assessmentRequirementItemId,
        input.datedWithin12Months,
        input.organizationSpecific,
        input.addressesRequirement,
        input.approvedByAuthority,
        input.currentlyInForce,
        input.evidenceQuality,
        input.reviewNotes,
        input.reviewedByUserId,
        input.reviewedAt,
      ],
    );
    return result.rows[0];
  }

  public async listCycles(
    orgId: string,
    input: ListCyclesInput,
    executor?: QueryExecutor,
  ): Promise<PaginatedResult<AssessmentCycleRecord>> {
    const db = executor ?? this.readExecutor;
    const conditions = ["org_id = $1"];
    const params: unknown[] = [orgId];
    if (input.status) {
      params.push(input.status);
      conditions.push(`status = $${params.length}`);
    }
    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const totalQuery = `
      SELECT count(*)::text AS total
      FROM assessment_cycles
      ${whereClause}
    `;
    const totalResult = await db.query<{ total: string }>(totalQuery, params);

    params.push(input.limit);
    params.push(input.offset);
    const listQuery = `
      SELECT
        id,
        org_id,
        status,
        cycle_type,
        source_correction_resubmission_id,
        source_assessment_cycle_id,
        created_by_user_id,
        finalized_internal_by_user_id,
        created_at,
        updated_at,
        finalized_internal_at
      FROM assessment_cycles
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const itemsResult = await db.query<AssessmentCycleRecord>(listQuery, params);
    return {
      total: asNumber(totalResult.rows[0]?.total ?? 0),
      items: itemsResult.rows,
    };
  }

  public async getCycleById(
    orgId: string,
    cycleId: string,
    executor?: QueryExecutor,
  ): Promise<AssessmentCycleRecord | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<AssessmentCycleRecord>(
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
        created_at,
        updated_at,
        finalized_internal_at
      FROM assessment_cycles
      WHERE org_id = $1
        AND id = $2
      `,
      [orgId, cycleId],
    );
    return result.rows[0] ?? null;
  }

  public async listCycleItems(
    orgId: string,
    cycleId: string,
    input: ListItemsInput,
    executor?: QueryExecutor,
  ): Promise<PaginatedResult<AssessmentItemRecord>> {
    const db = executor ?? this.readExecutor;
    const conditions = ["c.org_id = $1", "i.assessment_cycle_id = $2"];
    const params: unknown[] = [orgId, cycleId];
    if (input.status) {
      params.push(input.status);
      conditions.push(`i.assessment_status = $${params.length}`);
    }
    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const totalQuery = `
      SELECT count(*)::text AS total
      FROM assessment_requirement_items i
      JOIN assessment_cycles c ON c.id = i.assessment_cycle_id
      ${whereClause}
    `;
    const totalResult = await db.query<{ total: string }>(totalQuery, params);

    params.push(input.limit);
    params.push(input.offset);
    const listQuery = `
      SELECT
        i.id,
        i.assessment_cycle_id,
        i.pisf_requirement_id,
        i.requirement_key_snapshot,
        i.requirement_text_snapshot,
        i.source_hash_snapshot,
        i.assessment_status,
        i.updated_by_user_id,
        i.created_at,
        i.updated_at
      FROM assessment_requirement_items i
      JOIN assessment_cycles c ON c.id = i.assessment_cycle_id
      ${whereClause}
      ORDER BY i.requirement_key_snapshot ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const itemsResult = await db.query<AssessmentItemRecord>(listQuery, params);

    return {
      total: asNumber(totalResult.rows[0]?.total ?? 0),
      items: itemsResult.rows,
    };
  }
}

export type {
  ActorProfile,
  AppendAssessmentAuditInput,
  AssessmentCycleRecord,
  AssessmentCycleStatus,
  AssessmentCycleType,
  AssessmentEvidenceChecklistRecord,
  AssessmentItemRecord,
  AssessmentItemStatus,
  ChecklistAddressAnswer,
  ChecklistApprovalAnswer,
  ChecklistYesNo,
  ChecklistYesNoNa,
  EvidenceQuality,
  UpsertEvidenceChecklistInput,
};
