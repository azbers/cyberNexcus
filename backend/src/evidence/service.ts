import type { PoolClient } from "pg";

import { AUTH_ERRORS, AuthError } from "../auth/errors.js";
import type { AuthClaims, AuthRequestMeta } from "../auth/types.js";
import { assertCorrectionExecutionActiveForCycle } from "../correction-execution/guard.js";
import {
  EvidenceRepository,
  type EvidenceRecord,
} from "./repository.js";
import { LocalEvidenceStorage } from "./storage.js";

type UploadRole = "admin" | "responsible_officer" | "it_security_lead";

type UploadEvidenceInput = {
  cycleId: string;
  itemId: string;
  file: {
    originalName: string;
    mimeType: string | null;
    size: number;
    buffer: Buffer;
  } | null;
};

type RemoveEvidenceInput = {
  evidenceId: string;
  reason: string;
};

type ListEvidenceInput = {
  cycleId: string;
  itemId: string;
};

type UploadEvidenceResult = {
  evidence: EvidenceResponse;
};

type EvidenceListResult = {
  items: EvidenceResponse[];
};

type DownloadEvidenceResult = {
  evidenceId: string;
  fileName: string;
  mimeTypeDetected: string;
  fileSizeBytes: number;
  content: Buffer;
};

type RemoveEvidenceResult = {
  evidence: EvidenceResponse;
};

type EvidenceResponse = {
  id: string;
  org_id: string;
  assessment_cycle_id: string;
  assessment_requirement_item_id: string;
  original_filename: string;
  mime_type_detected: string;
  file_extension: string;
  file_size_bytes: number;
  sha256_hash: string;
  storage_backend: "LOCAL";
  validation_result_json: Record<string, unknown>;
  status: "UPLOADED" | "REMOVED";
  created_at: Date;
  updated_at: Date;
  removed_at: Date | null;
  removed_by_user_id: string | null;
  remove_reason: string | null;
};

type ServiceOptions = {
  repository: EvidenceRepository;
  storage: LocalEvidenceStorage;
  now?: () => Date;
};

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_ACTIVE_FILES_PER_ITEM = 10;
const ALLOWED_UPLOAD_ROLES = new Set<UploadRole>([
  "admin",
  "responsible_officer",
  "it_security_lead",
]);

function toEvidenceResponse(record: EvidenceRecord): EvidenceResponse {
  return {
    id: record.id,
    org_id: record.org_id,
    assessment_cycle_id: record.assessment_cycle_id,
    assessment_requirement_item_id: record.assessment_requirement_item_id,
    original_filename: record.original_filename,
    mime_type_detected: record.mime_type_detected,
    file_extension: record.file_extension,
    file_size_bytes: Number(record.file_size_bytes),
    sha256_hash: record.sha256_hash,
    storage_backend: record.storage_backend,
    validation_result_json: record.validation_result_json,
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
    removed_at: record.removed_at,
    removed_by_user_id: record.removed_by_user_id,
    remove_reason: record.remove_reason,
  };
}

export class EvidenceService {
  private readonly repository: EvidenceRepository;
  private readonly storage: LocalEvidenceStorage;
  private readonly now: () => Date;

  public constructor(options: ServiceOptions) {
    this.repository = options.repository;
    this.storage = options.storage;
    this.now = options.now ?? (() => new Date());
  }

  public async uploadEvidence(
    tx: PoolClient,
    claims: AuthClaims,
    input: UploadEvidenceInput,
    requestMeta: AuthRequestMeta,
  ): Promise<UploadEvidenceResult> {
    const actor = await this.resolveActor(tx, claims);
    if (!ALLOWED_UPLOAD_ROLES.has(actor.role as UploadRole)) {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }
    if (!input.file) {
      throw AUTH_ERRORS.EVIDENCE_FILE_REQUIRED();
    }
    if (input.file.size <= 0 || input.file.size > MAX_FILE_SIZE_BYTES) {
      throw AUTH_ERRORS.EVIDENCE_FILE_TOO_LARGE();
    }

    const tuple = await this.repository.getCycleItemTupleForUpdate(
      tx,
      claims.orgId,
      input.cycleId,
      input.itemId,
    );
    if (!tuple) {
      throw AUTH_ERRORS.ASSESSMENT_ITEM_NOT_FOUND();
    }
    if (tuple.cycle_status !== "DRAFT") {
      throw AUTH_ERRORS.ASSESSMENT_CYCLE_FINALIZED();
    }
    await assertCorrectionExecutionActiveForCycle(tx, {
      id: tuple.cycle_id,
      cycle_type: tuple.cycle_type,
    });

    const activeCount = await this.repository.countActiveEvidenceForItem(tx, tuple.item_id);
    if (activeCount >= MAX_ACTIVE_FILES_PER_ITEM) {
      throw AUTH_ERRORS.EVIDENCE_MAX_FILES_REACHED();
    }

    const detected = await this.storage.detectAndHash(
      input.file.buffer,
      input.file.originalName,
    );

    const stored = await this.storage.createStoredFile({
      buffer: input.file.buffer,
    });

    try {
      const validationResultJson = {
        extension_allowed: true,
        mime_detected: detected.detected.mimeType,
        size_allowed: true,
        sha256: detected.sha256Hash,
        malware_scan: "NOT_PERFORMED",
      };

      const created = await this.repository.insertEvidenceFile(tx, {
        orgId: claims.orgId,
        assessmentCycleId: tuple.cycle_id,
        assessmentRequirementItemId: tuple.item_id,
        uploadedByUserId: claims.userId,
        originalFilename: input.file.originalName,
        storedFilename: stored.storedFilename,
        storageKey: stored.storageKey,
        storageBackend: "LOCAL",
        mimeTypeClaimed: input.file.mimeType,
        mimeTypeDetected: detected.detected.mimeType,
        fileExtension: detected.detected.extension,
        fileSizeBytes: input.file.size,
        sha256Hash: detected.sha256Hash,
        validationResultJson,
      });

      const now = this.now();
      await this.repository.appendAuditEvent(tx, {
        eventType: "EVIDENCE_UPLOADED",
        severity: "INFO",
        userId: claims.userId,
        orgId: claims.orgId,
        ipAddress: requestMeta.ipAddress,
        userAgent: requestMeta.userAgent,
        metadata: this.buildAuditMetadata({
          now,
          claims,
          evidence: created,
          requestMeta,
        }),
      });

      return {
        evidence: toEvidenceResponse(created),
      };
    } catch (err) {
      await this.storage.removeFile(stored.storageKey);
      throw err;
    }
  }

  public async listEvidence(
    tx: PoolClient,
    claims: AuthClaims,
    input: ListEvidenceInput,
  ): Promise<EvidenceListResult> {
    await this.resolveActor(tx, claims);
    const tuple = await this.repository.getCycleItemTupleForRead(
      claims.orgId,
      input.cycleId,
      input.itemId,
      tx,
    );
    if (!tuple) {
      throw AUTH_ERRORS.ASSESSMENT_ITEM_NOT_FOUND();
    }
    const rows = await this.repository.listEvidenceForItem(
      claims.orgId,
      tuple.cycle_id,
      tuple.item_id,
      tx,
    );
    return {
      items: rows.map((row) => toEvidenceResponse(row)),
    };
  }

  public async downloadEvidence(
    tx: PoolClient,
    claims: AuthClaims,
    evidenceId: string,
    requestMeta: AuthRequestMeta,
  ): Promise<DownloadEvidenceResult> {
    await this.resolveActor(tx, claims);

    const evidence = await this.repository.getEvidenceById(claims.orgId, evidenceId, tx);
    if (!evidence || evidence.status !== "UPLOADED") {
      throw AUTH_ERRORS.EVIDENCE_NOT_FOUND();
    }

    let content: Buffer;
    try {
      content = await this.storage.readFile(evidence.storage_key);
    } catch (err) {
      if (err instanceof AuthError) {
        throw err;
      }
      throw AUTH_ERRORS.EVIDENCE_NOT_FOUND();
    }

    const now = this.now();
    await this.repository.appendAuditEvent(tx, {
      eventType: "EVIDENCE_DOWNLOADED",
      severity: "INFO",
      userId: claims.userId,
      orgId: claims.orgId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: this.buildAuditMetadata({
        now,
        claims,
        evidence,
        requestMeta,
      }),
    });

    return {
      evidenceId: evidence.id,
      fileName: evidence.original_filename,
      mimeTypeDetected: evidence.mime_type_detected,
      fileSizeBytes: Number(evidence.file_size_bytes),
      content,
    };
  }

  public async removeEvidence(
    tx: PoolClient,
    claims: AuthClaims,
    input: RemoveEvidenceInput,
    requestMeta: AuthRequestMeta,
  ): Promise<RemoveEvidenceResult> {
    const actor = await this.resolveActor(tx, claims);
    if (!ALLOWED_UPLOAD_ROLES.has(actor.role as UploadRole)) {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const reason = input.reason.trim();
    if (reason.length < 10 || reason.length > 2000) {
      throw AUTH_ERRORS.EVIDENCE_REMOVE_REASON_INVALID();
    }

    const existing = await this.repository.getEvidenceForUpdate(
      tx,
      claims.orgId,
      input.evidenceId,
    );
    if (!existing) {
      throw AUTH_ERRORS.EVIDENCE_NOT_FOUND();
    }
    if (existing.cycle_status !== "DRAFT") {
      throw AUTH_ERRORS.ASSESSMENT_CYCLE_FINALIZED();
    }
    await assertCorrectionExecutionActiveForCycle(tx, {
      id: existing.assessment_cycle_id,
      cycle_type: existing.cycle_type,
    });
    if (existing.status !== "UPLOADED") {
      throw AUTH_ERRORS.EVIDENCE_ALREADY_REMOVED();
    }

    const now = this.now();
    const removed = await this.repository.softRemoveEvidence(tx, {
      evidenceId: existing.id,
      removedByUserId: claims.userId,
      removedAt: now,
      removeReason: reason,
    });
    if (!removed) {
      throw AUTH_ERRORS.CONFLICT();
    }

    await this.repository.appendAuditEvent(tx, {
      eventType: "EVIDENCE_REMOVED",
      severity: "INFO",
      userId: claims.userId,
      orgId: claims.orgId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: this.buildAuditMetadata({
        now,
        claims,
        evidence: removed,
        requestMeta,
      }),
    });

    return {
      evidence: toEvidenceResponse(removed),
    };
  }

  private async resolveActor(
    tx: PoolClient,
    claims: AuthClaims,
  ): Promise<{ role: string; orgId: string }> {
    const actor = await this.repository.findActorProfile(tx, claims.userId);
    if (!actor || actor.org_id !== claims.orgId) {
      throw AUTH_ERRORS.UNAUTHORIZED();
    }
    return { role: actor.role, orgId: actor.org_id };
  }

  private buildAuditMetadata(input: {
    now: Date;
    claims: AuthClaims;
    evidence: EvidenceRecord;
    requestMeta: AuthRequestMeta;
  }): Record<string, unknown> {
    return {
      org_id: input.evidence.org_id,
      assessment_cycle_id: input.evidence.assessment_cycle_id,
      assessment_requirement_item_id: input.evidence.assessment_requirement_item_id,
      evidence_file_id: input.evidence.id,
      filename: input.evidence.original_filename,
      sha256_hash: input.evidence.sha256_hash,
      actor_user_id: input.claims.userId,
      actor_org_id: input.claims.orgId,
      timestamp: input.now.toISOString(),
      request_ip: input.requestMeta.ipAddress,
      user_agent: input.requestMeta.userAgent,
    };
  }
}

export type {
  DownloadEvidenceResult,
  EvidenceListResult,
  EvidenceResponse,
  RemoveEvidenceResult,
  UploadEvidenceResult,
};
