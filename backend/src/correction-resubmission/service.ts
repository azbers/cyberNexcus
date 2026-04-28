import type { PoolClient } from "pg";

import { AUTH_ERRORS } from "../auth/errors.js";
import type { AuthClaims, AuthRequestMeta } from "../auth/types.js";
import {
  CorrectionResubmissionRepository,
  type ActorProfile,
  type CorrectionResubmissionRecord,
  type CorrectionResubmissionStatus,
} from "./repository.js";

type CorrectionResubmissionResponse = {
  id: string;
  orgId: string;
  originalExternalSubmissionId: string;
  originalDecisionId: string;
  originalSubmissionPackageId: string;
  originalAssessmentCycleId: string;
  status: CorrectionResubmissionStatus;
  correctionReason: string;
  correctionSummary: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  readyByUserId: string | null;
  readyAt: Date | null;
  voidedByUserId: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
};

type CorrectionListResponse = {
  items: CorrectionResubmissionResponse[];
};

type ServiceOptions = {
  repository: CorrectionResubmissionRepository;
  now?: () => Date;
};

const SUMMARY_ALLOWED_ROLES = new Set([
  "admin",
  "responsible_officer",
  "it_security_lead",
]);

export class CorrectionResubmissionService {
  private readonly repository: CorrectionResubmissionRepository;
  private readonly now: () => Date;

  public constructor(options: ServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
  }

  public async createCorrection(
    tx: PoolClient,
    claims: AuthClaims,
    externalSubmissionId: string,
    input: { correctionReason?: unknown },
    requestMeta: AuthRequestMeta,
  ): Promise<CorrectionResubmissionResponse> {
    const actor = await this.resolveActor(tx, claims);
    if (actor.role !== "admin") {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const context = await this.repository.getExternalSubmissionDecisionContext(
      claims.orgId,
      externalSubmissionId,
      tx,
    );
    if (!context) {
      throw AUTH_ERRORS.EXTERNAL_SUBMISSION_NOT_FOUND();
    }
    if (!context.decision_id || context.decision !== "RETURNED_FOR_CORRECTION") {
      throw AUTH_ERRORS.CORRECTION_RESUBMISSION_REQUIRES_RETURNED_DECISION();
    }

    const active = await this.repository.activeCorrectionExistsForDecision(
      claims.orgId,
      context.decision_id,
      tx,
    );
    if (active) {
      throw AUTH_ERRORS.CORRECTION_RESUBMISSION_ALREADY_EXISTS();
    }

    const correctionReason = this.normalizeCorrectionReason(input.correctionReason);
    const created = await this.repository.insertCorrection(tx, {
      orgId: claims.orgId,
      originalExternalSubmissionId: context.external_submission_id,
      originalDecisionId: context.decision_id,
      originalSubmissionPackageId: context.submission_package_id,
      originalAssessmentCycleId: context.assessment_cycle_id,
      correctionReason,
      createdByUserId: claims.userId,
    });

    await this.audit(tx, "CORRECTION_RESUBMISSION_CREATED", claims, created, requestMeta);
    return this.toResponse(created);
  }

  public async listCorrectionsForSubmission(
    tx: PoolClient,
    claims: AuthClaims,
    externalSubmissionId: string,
  ): Promise<CorrectionListResponse> {
    await this.resolveActor(tx, claims);
    const context = await this.repository.getExternalSubmissionDecisionContext(
      claims.orgId,
      externalSubmissionId,
      tx,
    );
    if (!context) {
      throw AUTH_ERRORS.EXTERNAL_SUBMISSION_NOT_FOUND();
    }
    const items = await this.repository.listCorrectionsForSubmission(
      claims.orgId,
      externalSubmissionId,
      tx,
    );
    return { items: items.map((item) => this.toResponse(item)) };
  }

  public async getCorrectionById(
    tx: PoolClient,
    claims: AuthClaims,
    correctionId: string,
  ): Promise<CorrectionResubmissionResponse> {
    await this.resolveActor(tx, claims);
    const correction = await this.repository.getCorrectionById(
      claims.orgId,
      correctionId,
      tx,
    );
    if (!correction) {
      throw AUTH_ERRORS.CORRECTION_RESUBMISSION_NOT_FOUND();
    }
    return this.toResponse(correction);
  }

  public async updateSummary(
    tx: PoolClient,
    claims: AuthClaims,
    correctionId: string,
    input: { correctionSummary?: unknown },
    requestMeta: AuthRequestMeta,
  ): Promise<CorrectionResubmissionResponse> {
    const actor = await this.resolveActor(tx, claims);
    if (!SUMMARY_ALLOWED_ROLES.has(actor.role)) {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const correction = await this.repository.getCorrectionForUpdate(
      tx,
      claims.orgId,
      correctionId,
    );
    if (!correction) {
      throw AUTH_ERRORS.CORRECTION_RESUBMISSION_NOT_FOUND();
    }
    if (correction.status !== "DRAFT") {
      throw AUTH_ERRORS.INVALID_CORRECTION_RESUBMISSION_STATUS();
    }

    const correctionSummary = this.normalizeCorrectionSummary(input.correctionSummary);
    const updated = await this.repository.updateSummary(tx, {
      orgId: claims.orgId,
      correctionId: correction.id,
      correctionSummary,
    });
    if (!updated) {
      throw AUTH_ERRORS.CONFLICT();
    }

    await this.audit(tx, "CORRECTION_RESUBMISSION_SUMMARY_UPDATED", claims, updated, requestMeta);
    return this.toResponse(updated);
  }

  public async markReady(
    tx: PoolClient,
    claims: AuthClaims,
    correctionId: string,
    requestMeta: AuthRequestMeta,
  ): Promise<CorrectionResubmissionResponse> {
    const actor = await this.resolveActor(tx, claims);
    if (actor.role !== "admin") {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const correction = await this.repository.getCorrectionForUpdate(
      tx,
      claims.orgId,
      correctionId,
    );
    if (!correction) {
      throw AUTH_ERRORS.CORRECTION_RESUBMISSION_NOT_FOUND();
    }
    if (correction.status !== "DRAFT") {
      throw AUTH_ERRORS.INVALID_CORRECTION_RESUBMISSION_STATUS();
    }
    if (!correction.correction_summary || correction.correction_summary.trim().length < 20) {
      throw AUTH_ERRORS.INVALID_CORRECTION_RESUBMISSION();
    }

    const updated = await this.repository.markReady(tx, {
      orgId: claims.orgId,
      correctionId: correction.id,
      readyByUserId: claims.userId,
      readyAt: this.now(),
    });
    if (!updated) {
      throw AUTH_ERRORS.CONFLICT();
    }

    await this.audit(tx, "CORRECTION_RESUBMISSION_MARKED_READY", claims, updated, requestMeta);
    return this.toResponse(updated);
  }

  public async voidCorrection(
    tx: PoolClient,
    claims: AuthClaims,
    correctionId: string,
    reasonInput: unknown,
    requestMeta: AuthRequestMeta,
  ): Promise<CorrectionResubmissionResponse> {
    const actor = await this.resolveActor(tx, claims);
    if (actor.role !== "admin") {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const correction = await this.repository.getCorrectionForUpdate(
      tx,
      claims.orgId,
      correctionId,
    );
    if (!correction) {
      throw AUTH_ERRORS.CORRECTION_RESUBMISSION_NOT_FOUND();
    }
    if (correction.status !== "DRAFT" && correction.status !== "READY_FOR_RESUBMISSION") {
      throw AUTH_ERRORS.INVALID_CORRECTION_RESUBMISSION_STATUS();
    }

    const reason = this.normalizeVoidReason(reasonInput);
    const updated = await this.repository.voidCorrection(tx, {
      orgId: claims.orgId,
      correctionId: correction.id,
      voidedByUserId: claims.userId,
      voidedAt: this.now(),
      voidReason: reason,
    });
    if (!updated) {
      throw AUTH_ERRORS.CONFLICT();
    }

    await this.audit(tx, "CORRECTION_RESUBMISSION_VOIDED", claims, updated, requestMeta, {
      reason,
    });
    return this.toResponse(updated);
  }

  private async resolveActor(
    tx: PoolClient,
    claims: AuthClaims,
  ): Promise<ActorProfile> {
    const actor = await this.repository.findActorProfile(tx, claims.userId);
    if (!actor || actor.org_id !== claims.orgId) {
      throw AUTH_ERRORS.UNAUTHORIZED();
    }
    return actor;
  }

  private normalizeCorrectionReason(value: unknown): string {
    if (typeof value !== "string") {
      throw AUTH_ERRORS.INVALID_CORRECTION_RESUBMISSION();
    }
    const trimmed = value.trim();
    if (trimmed.length < 20 || trimmed.length > 5000) {
      throw AUTH_ERRORS.INVALID_CORRECTION_RESUBMISSION();
    }
    return trimmed;
  }

  private normalizeCorrectionSummary(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== "string") {
      throw AUTH_ERRORS.INVALID_CORRECTION_RESUBMISSION();
    }
    if (value.length > 5000) {
      throw AUTH_ERRORS.INVALID_CORRECTION_RESUBMISSION();
    }
    return value;
  }

  private normalizeVoidReason(value: unknown): string {
    if (typeof value !== "string") {
      throw AUTH_ERRORS.INVALID_CORRECTION_RESUBMISSION_VOID_REASON();
    }
    const trimmed = value.trim();
    if (trimmed.length < 10 || trimmed.length > 2000) {
      throw AUTH_ERRORS.INVALID_CORRECTION_RESUBMISSION_VOID_REASON();
    }
    return trimmed;
  }

  private async audit(
    tx: PoolClient,
    eventType:
      | "CORRECTION_RESUBMISSION_CREATED"
      | "CORRECTION_RESUBMISSION_SUMMARY_UPDATED"
      | "CORRECTION_RESUBMISSION_MARKED_READY"
      | "CORRECTION_RESUBMISSION_VOIDED",
    claims: AuthClaims,
    correction: CorrectionResubmissionRecord,
    requestMeta: AuthRequestMeta,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    const now = this.now();
    await this.repository.appendAuditEvent(tx, {
      eventType,
      severity: "INFO",
      userId: claims.userId,
      orgId: claims.orgId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: {
        category: eventType.toLowerCase(),
        org_id: claims.orgId,
        correction_resubmission_id: correction.id,
        original_external_submission_id: correction.original_external_submission_id,
        original_decision_id: correction.original_decision_id,
        original_submission_package_id: correction.original_submission_package_id,
        original_assessment_cycle_id: correction.original_assessment_cycle_id,
        actor_user_id: claims.userId,
        actor_org_id: claims.orgId,
        timestamp: now.toISOString(),
        request_ip: requestMeta.ipAddress,
        user_agent: requestMeta.userAgent,
        ...extra,
      },
    });
  }

  private toResponse(record: CorrectionResubmissionRecord): CorrectionResubmissionResponse {
    return {
      id: record.id,
      orgId: record.org_id,
      originalExternalSubmissionId: record.original_external_submission_id,
      originalDecisionId: record.original_decision_id,
      originalSubmissionPackageId: record.original_submission_package_id,
      originalAssessmentCycleId: record.original_assessment_cycle_id,
      status: record.status,
      correctionReason: record.correction_reason,
      correctionSummary: record.correction_summary,
      createdByUserId: record.created_by_user_id,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
      readyByUserId: record.ready_by_user_id,
      readyAt: record.ready_at,
      voidedByUserId: record.voided_by_user_id,
      voidedAt: record.voided_at,
      voidReason: record.void_reason,
    };
  }
}

export type { CorrectionListResponse, CorrectionResubmissionResponse };
