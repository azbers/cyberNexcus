import type { Pool, PoolClient } from "pg";

import { AUTH_ERRORS } from "../auth/errors.js";
import {
  AUDIT_EVENT_TYPES,
  AUDIT_SEVERITIES,
  type AuditEventType,
  type AuditSeverity,
} from "../auth/types.js";

type QueryExecutor = Pick<Pool, "query"> | Pick<PoolClient, "query">;

type EvidenceStatus = "UPLOADED" | "REMOVED";
type CycleStatus = "DRAFT" | "FINALIZED_INTERNAL" | "READY_FOR_SUBMISSION";
type CycleType = "NORMAL" | "CORRECTION";

type EvidenceActorProfile = {
  user_id: string;
  org_id: string;
  role: string;
};

type CycleItemTuple = {
  org_id: string;
  cycle_id: string;
  cycle_status: CycleStatus;
  cycle_type: CycleType;
  item_id: string;
};

type EvidenceRecord = {
  id: string;
  org_id: string;
  assessment_cycle_id: string;
  assessment_requirement_item_id: string;
  uploaded_by_user_id: string;
  original_filename: string;
  stored_filename: string;
  storage_key: string;
  storage_backend: "LOCAL";
  mime_type_claimed: string | null;
  mime_type_detected: string;
  file_extension: string;
  file_size_bytes: string;
  sha256_hash: string;
  validation_result_json: Record<string, unknown>;
  status: EvidenceStatus;
  removed_at: Date | null;
  removed_by_user_id: string | null;
  remove_reason: string | null;
  created_at: Date;
  updated_at: Date;
};

type InsertEvidenceInput = {
  orgId: string;
  assessmentCycleId: string;
  assessmentRequirementItemId: string;
  uploadedByUserId: string;
  originalFilename: string;
  storedFilename: string;
  storageKey: string;
  storageBackend: "LOCAL";
  mimeTypeClaimed: string | null;
  mimeTypeDetected: string;
  fileExtension: string;
  fileSizeBytes: number;
  sha256Hash: string;
  validationResultJson: Record<string, unknown>;
};

type SoftRemoveEvidenceInput = {
  evidenceId: string;
  removedByUserId: string;
  removedAt: Date;
  removeReason: string;
};

type AppendEvidenceAuditInput = {
  eventType: "EVIDENCE_UPLOADED" | "EVIDENCE_REMOVED" | "EVIDENCE_DOWNLOADED";
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

function asNumber(value: string | number): number {
  if (typeof value === "number") {
    return value;
  }
  return Number(value);
}

function validateAuditEvent(input: AppendEvidenceAuditInput): void {
  if (!AUDIT_EVENT_TYPES.includes(input.eventType as AuditEventType)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
  if (!AUDIT_SEVERITIES.includes(input.severity)) {
    throw AUTH_ERRORS.INVALID_AUDIT_EVENT();
  }
}

export class EvidenceRepository {
  private readonly readExecutor: QueryExecutor;

  public constructor(readExecutor: QueryExecutor) {
    this.readExecutor = readExecutor;
  }

  public async findActorProfile(
    tx: PoolClient | undefined,
    userId: string,
  ): Promise<EvidenceActorProfile | null> {
    const client = assertTx(tx);
    const result = await client.query<EvidenceActorProfile>(
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

  public async getCycleItemTupleForRead(
    orgId: string,
    cycleId: string,
    itemId: string,
    executor?: QueryExecutor,
  ): Promise<CycleItemTuple | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<CycleItemTuple>(
      `
      SELECT
        c.org_id,
        c.id AS cycle_id,
        c.status AS cycle_status,
        c.cycle_type,
        i.id AS item_id
      FROM assessment_cycles c
      JOIN assessment_requirement_items i
        ON i.assessment_cycle_id = c.id
      WHERE c.org_id = $1
        AND c.id = $2
        AND i.id = $3
      `,
      [orgId, cycleId, itemId],
    );
    return result.rows[0] ?? null;
  }

  public async getCycleItemTupleForUpdate(
    tx: PoolClient | undefined,
    orgId: string,
    cycleId: string,
    itemId: string,
  ): Promise<CycleItemTuple | null> {
    const client = assertTx(tx);
    const result = await client.query<CycleItemTuple>(
      `
      SELECT
        c.org_id,
        c.id AS cycle_id,
        c.status AS cycle_status,
        c.cycle_type,
        i.id AS item_id
      FROM assessment_cycles c
      JOIN assessment_requirement_items i
        ON i.assessment_cycle_id = c.id
      WHERE c.org_id = $1
        AND c.id = $2
        AND i.id = $3
      FOR UPDATE OF c, i
      `,
      [orgId, cycleId, itemId],
    );
    return result.rows[0] ?? null;
  }

  public async countActiveEvidenceForItem(
    tx: PoolClient | undefined,
    itemId: string,
  ): Promise<number> {
    const client = assertTx(tx);
    const result = await client.query<{ total: string }>(
      `
      SELECT count(*)::text AS total
      FROM assessment_evidence_files
      WHERE assessment_requirement_item_id = $1
        AND status = 'UPLOADED'
      `,
      [itemId],
    );
    return asNumber(result.rows[0]?.total ?? 0);
  }

  public async insertEvidenceFile(
    tx: PoolClient | undefined,
    input: InsertEvidenceInput,
  ): Promise<EvidenceRecord> {
    const client = assertTx(tx);
    const result = await client.query<EvidenceRecord>(
      `
      INSERT INTO assessment_evidence_files (
        org_id,
        assessment_cycle_id,
        assessment_requirement_item_id,
        uploaded_by_user_id,
        original_filename,
        stored_filename,
        storage_key,
        storage_backend,
        mime_type_claimed,
        mime_type_detected,
        file_extension,
        file_size_bytes,
        sha256_hash,
        validation_result_json,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, 'UPLOADED')
      RETURNING
        id,
        org_id,
        assessment_cycle_id,
        assessment_requirement_item_id,
        uploaded_by_user_id,
        original_filename,
        stored_filename,
        storage_key,
        storage_backend,
        mime_type_claimed,
        mime_type_detected,
        file_extension,
        file_size_bytes,
        sha256_hash,
        validation_result_json,
        status,
        removed_at,
        removed_by_user_id,
        remove_reason,
        created_at,
        updated_at
      `,
      [
        input.orgId,
        input.assessmentCycleId,
        input.assessmentRequirementItemId,
        input.uploadedByUserId,
        input.originalFilename,
        input.storedFilename,
        input.storageKey,
        input.storageBackend,
        input.mimeTypeClaimed,
        input.mimeTypeDetected,
        input.fileExtension,
        input.fileSizeBytes,
        input.sha256Hash,
        JSON.stringify(input.validationResultJson),
      ],
    );
    return result.rows[0];
  }

  public async listEvidenceForItem(
    orgId: string,
    cycleId: string,
    itemId: string,
    executor?: QueryExecutor,
  ): Promise<EvidenceRecord[]> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<EvidenceRecord>(
      `
      SELECT
        e.id,
        e.org_id,
        e.assessment_cycle_id,
        e.assessment_requirement_item_id,
        e.uploaded_by_user_id,
        e.original_filename,
        e.stored_filename,
        e.storage_key,
        e.storage_backend,
        e.mime_type_claimed,
        e.mime_type_detected,
        e.file_extension,
        e.file_size_bytes,
        e.sha256_hash,
        e.validation_result_json,
        e.status,
        e.removed_at,
        e.removed_by_user_id,
        e.remove_reason,
        e.created_at,
        e.updated_at
      FROM assessment_evidence_files e
      WHERE e.org_id = $1
        AND e.assessment_cycle_id = $2
        AND e.assessment_requirement_item_id = $3
        AND e.status = 'UPLOADED'
      ORDER BY e.created_at DESC
      `,
      [orgId, cycleId, itemId],
    );
    return result.rows;
  }

  public async getEvidenceById(
    orgId: string,
    evidenceId: string,
    executor?: QueryExecutor,
  ): Promise<EvidenceRecord | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<EvidenceRecord>(
      `
      SELECT
        id,
        org_id,
        assessment_cycle_id,
        assessment_requirement_item_id,
        uploaded_by_user_id,
        original_filename,
        stored_filename,
        storage_key,
        storage_backend,
        mime_type_claimed,
        mime_type_detected,
        file_extension,
        file_size_bytes,
        sha256_hash,
        validation_result_json,
        status,
        removed_at,
        removed_by_user_id,
        remove_reason,
        created_at,
        updated_at
      FROM assessment_evidence_files
      WHERE org_id = $1
        AND id = $2
      `,
      [orgId, evidenceId],
    );
    return result.rows[0] ?? null;
  }

  public async getEvidenceForUpdate(
    tx: PoolClient | undefined,
    orgId: string,
    evidenceId: string,
  ): Promise<(EvidenceRecord & { cycle_status: CycleStatus; cycle_type: CycleType }) | null> {
    const client = assertTx(tx);
    const result = await client.query<EvidenceRecord & { cycle_status: CycleStatus; cycle_type: CycleType }>(
      `
      SELECT
        e.id,
        e.org_id,
        e.assessment_cycle_id,
        e.assessment_requirement_item_id,
        e.uploaded_by_user_id,
        e.original_filename,
        e.stored_filename,
        e.storage_key,
        e.storage_backend,
        e.mime_type_claimed,
        e.mime_type_detected,
        e.file_extension,
        e.file_size_bytes,
        e.sha256_hash,
        e.validation_result_json,
        e.status,
        e.removed_at,
        e.removed_by_user_id,
        e.remove_reason,
        e.created_at,
        e.updated_at,
        c.status AS cycle_status,
        c.cycle_type
      FROM assessment_evidence_files e
      JOIN assessment_cycles c
        ON c.id = e.assessment_cycle_id
      WHERE e.org_id = $1
        AND e.id = $2
      FOR UPDATE OF e, c
      `,
      [orgId, evidenceId],
    );
    return result.rows[0] ?? null;
  }

  public async softRemoveEvidence(
    tx: PoolClient | undefined,
    input: SoftRemoveEvidenceInput,
  ): Promise<EvidenceRecord | null> {
    const client = assertTx(tx);
    const result = await client.query<EvidenceRecord>(
      `
      UPDATE assessment_evidence_files
      SET status = 'REMOVED',
          removed_at = $2,
          removed_by_user_id = $3,
          remove_reason = $4
      WHERE id = $1
        AND status = 'UPLOADED'
      RETURNING
        id,
        org_id,
        assessment_cycle_id,
        assessment_requirement_item_id,
        uploaded_by_user_id,
        original_filename,
        stored_filename,
        storage_key,
        storage_backend,
        mime_type_claimed,
        mime_type_detected,
        file_extension,
        file_size_bytes,
        sha256_hash,
        validation_result_json,
        status,
        removed_at,
        removed_by_user_id,
        remove_reason,
        created_at,
        updated_at
      `,
      [
        input.evidenceId,
        input.removedAt,
        input.removedByUserId,
        input.removeReason,
      ],
    );
    return result.rows[0] ?? null;
  }

  public async appendAuditEvent(
    tx: PoolClient | undefined,
    input: AppendEvidenceAuditInput,
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
  EvidenceActorProfile,
  CycleItemTuple,
  EvidenceRecord,
  EvidenceStatus,
  InsertEvidenceInput,
};
