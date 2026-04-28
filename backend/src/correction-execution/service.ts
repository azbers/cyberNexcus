import type { PoolClient } from "pg";

import { AUTH_ERRORS } from "../auth/errors.js";
import type { AuthClaims, AuthRequestMeta } from "../auth/types.js";
import {
  CorrectionExecutionRepository,
  type CorrectionExecutionRecord,
  type CorrectionExecutionStatus,
} from "./repository.js";

type CorrectionExecutionResponse = {
  id: string;
  orgId: string;
  correctionResubmissionId: string;
  originalAssessmentCycleId: string;
  correctionAssessmentCycleId: string;
  status: CorrectionExecutionStatus;
  createdByUserId: string;
  createdAt: Date;
  voidedByUserId: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  updatedAt: Date;
};

type ServiceOptions = {
  repository: CorrectionExecutionRepository;
  now?: () => Date;
};

export class CorrectionExecutionService {
  private readonly repository: CorrectionExecutionRepository;
  private readonly now: () => Date;

  public constructor(options: ServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
  }

  public async createExecutionCycle(
    tx: PoolClient,
    claims: AuthClaims,
    correctionId: string,
    requestMeta: AuthRequestMeta,
  ): Promise<CorrectionExecutionResponse> {
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
    if (correction.status !== "READY_FOR_RESUBMISSION") {
      throw AUTH_ERRORS.CORRECTION_EXECUTION_REQUIRES_READY_CORRECTION();
    }
    if (correction.decision !== "RETURNED_FOR_CORRECTION") {
      throw AUTH_ERRORS.CORRECTION_RESUBMISSION_REQUIRES_RETURNED_DECISION();
    }
    if (
      await this.repository.activeExecutionExistsForCorrection(
        tx,
        claims.orgId,
        correction.id,
      )
    ) {
      throw AUTH_ERRORS.CORRECTION_EXECUTION_CYCLE_ALREADY_EXISTS();
    }

    const cycle = await this.repository.insertCorrectionAssessmentCycle(tx, {
      orgId: claims.orgId,
      sourceCorrectionResubmissionId: correction.id,
      sourceAssessmentCycleId: correction.original_assessment_cycle_id,
      createdByUserId: claims.userId,
    });
    const clonedItemCount = await this.repository.cloneRequirementItems(
      tx,
      correction.original_assessment_cycle_id,
      cycle.id,
    );
    const execution = await this.repository.insertExecution(tx, {
      orgId: claims.orgId,
      correctionResubmissionId: correction.id,
      originalAssessmentCycleId: correction.original_assessment_cycle_id,
      correctionAssessmentCycleId: cycle.id,
      createdByUserId: claims.userId,
    });

    await this.audit(tx, "CORRECTION_EXECUTION_CYCLE_CREATED", claims, execution, requestMeta, {
      cloned_item_count: clonedItemCount,
    });
    return this.toResponse(execution);
  }

  public async getActiveExecutionByCorrection(
    tx: PoolClient,
    claims: AuthClaims,
    correctionId: string,
  ): Promise<CorrectionExecutionResponse> {
    await this.resolveActor(tx, claims);
    const execution = await this.repository.getActiveExecutionByCorrection(
      claims.orgId,
      correctionId,
      tx,
    );
    if (!execution) {
      throw AUTH_ERRORS.CORRECTION_EXECUTION_CYCLE_NOT_FOUND();
    }
    return this.toResponse(execution);
  }

  public async getExecutionById(
    tx: PoolClient,
    claims: AuthClaims,
    executionId: string,
  ): Promise<CorrectionExecutionResponse> {
    await this.resolveActor(tx, claims);
    const execution = await this.repository.getExecutionById(
      claims.orgId,
      executionId,
      tx,
    );
    if (!execution) {
      throw AUTH_ERRORS.CORRECTION_EXECUTION_CYCLE_NOT_FOUND();
    }
    return this.toResponse(execution);
  }

  public async voidExecutionCycle(
    tx: PoolClient,
    claims: AuthClaims,
    executionId: string,
    reasonInput: unknown,
    requestMeta: AuthRequestMeta,
  ): Promise<CorrectionExecutionResponse> {
    const actor = await this.resolveActor(tx, claims);
    if (actor.role !== "admin") {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const execution = await this.repository.getExecutionForUpdate(
      tx,
      claims.orgId,
      executionId,
    );
    if (!execution) {
      throw AUTH_ERRORS.CORRECTION_EXECUTION_CYCLE_NOT_FOUND();
    }
    if (execution.status !== "CREATED") {
      throw AUTH_ERRORS.INVALID_CORRECTION_EXECUTION_STATUS();
    }

    const cycle = await this.repository.getAssessmentCycleForUpdate(
      tx,
      claims.orgId,
      execution.correction_assessment_cycle_id,
    );
    if (!cycle) {
      throw AUTH_ERRORS.ASSESSMENT_CYCLE_NOT_FOUND();
    }
    if (cycle.status !== "DRAFT") {
      throw AUTH_ERRORS.INVALID_CORRECTION_EXECUTION_STATUS();
    }

    const reason = this.normalizeVoidReason(reasonInput);
    const voided = await this.repository.voidExecution(tx, {
      orgId: claims.orgId,
      executionId: execution.id,
      voidedByUserId: claims.userId,
      voidedAt: this.now(),
      voidReason: reason,
    });
    if (!voided) {
      throw AUTH_ERRORS.CONFLICT();
    }

    await this.audit(tx, "CORRECTION_EXECUTION_CYCLE_VOIDED", claims, voided, requestMeta, {
      reason,
    });
    return this.toResponse(voided);
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

  private normalizeVoidReason(value: unknown): string {
    if (typeof value !== "string") {
      throw AUTH_ERRORS.INVALID_CORRECTION_EXECUTION_VOID_REASON();
    }
    const trimmed = value.trim();
    if (trimmed.length < 10 || trimmed.length > 2000) {
      throw AUTH_ERRORS.INVALID_CORRECTION_EXECUTION_VOID_REASON();
    }
    return trimmed;
  }

  private async audit(
    tx: PoolClient,
    eventType: "CORRECTION_EXECUTION_CYCLE_CREATED" | "CORRECTION_EXECUTION_CYCLE_VOIDED",
    claims: AuthClaims,
    execution: CorrectionExecutionRecord,
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
        correction_resubmission_id: execution.correction_resubmission_id,
        correction_execution_cycle_id: execution.id,
        original_assessment_cycle_id: execution.original_assessment_cycle_id,
        correction_assessment_cycle_id: execution.correction_assessment_cycle_id,
        actor_user_id: claims.userId,
        actor_org_id: claims.orgId,
        timestamp: now.toISOString(),
        request_ip: requestMeta.ipAddress,
        user_agent: requestMeta.userAgent,
        ...extra,
      },
    });
  }

  private toResponse(record: CorrectionExecutionRecord): CorrectionExecutionResponse {
    return {
      id: record.id,
      orgId: record.org_id,
      correctionResubmissionId: record.correction_resubmission_id,
      originalAssessmentCycleId: record.original_assessment_cycle_id,
      correctionAssessmentCycleId: record.correction_assessment_cycle_id,
      status: record.status,
      createdByUserId: record.created_by_user_id,
      createdAt: record.created_at,
      voidedByUserId: record.voided_by_user_id,
      voidedAt: record.voided_at,
      voidReason: record.void_reason,
      updatedAt: record.updated_at,
    };
  }
}

export type { CorrectionExecutionResponse };
