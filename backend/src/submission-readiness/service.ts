import type { PoolClient } from "pg";

import { AUTH_ERRORS } from "../auth/errors.js";
import type { AuthClaims, AuthRequestMeta } from "../auth/types.js";
import { assertCorrectionExecutionActiveForCycle } from "../correction-execution/guard.js";
import {
  SubmissionReadinessRepository,
  type ScoreSnapshotForReadiness,
  type SubmissionReadinessRecord,
} from "./repository.js";

type SubmissionReadinessInput = {
  confirmedAssessmentComplete?: unknown;
  confirmedEvidenceAttached?: unknown;
  confirmedEvidenceReviewed?: unknown;
  confirmedScoreReviewed?: unknown;
  confirmedAuthorizedSubmitter?: unknown;
  confirmedInformationAccurate?: unknown;
  declarationText?: unknown;
  reviewNotes?: unknown;
};

type SubmissionReadinessResponse = {
  id: string;
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
  createdAt: Date;
  updatedAt: Date;
};

type MarkReadyResponse = {
  id: string;
  orgId: string;
  status: "READY_FOR_SUBMISSION";
  finalizedInternalAt: Date | null;
  scoreSnapshotId: string;
  overallScore: string | null;
  overallLabel: string | null;
};

type ServiceOptions = {
  repository: SubmissionReadinessRepository;
  now?: () => Date;
};

const WRITE_ALLOWED_ROLES = new Set([
  "admin",
  "responsible_officer",
  "it_security_lead",
]);

export class SubmissionReadinessService {
  private readonly repository: SubmissionReadinessRepository;
  private readonly now: () => Date;

  public constructor(options: ServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
  }

  public async getReadiness(
    tx: PoolClient,
    claims: AuthClaims,
    cycleId: string,
  ): Promise<SubmissionReadinessResponse> {
    await this.resolveActor(tx, claims);
    const cycle = await this.repository.getCycleByOrg(claims.orgId, cycleId, tx);
    if (!cycle) {
      throw AUTH_ERRORS.ASSESSMENT_CYCLE_NOT_FOUND();
    }
    const readiness = await this.repository.getReadinessByCycle(
      claims.orgId,
      cycle.id,
      tx,
    );
    if (!readiness) {
      throw AUTH_ERRORS.SUBMISSION_READINESS_NOT_FOUND();
    }
    return this.toResponse(readiness);
  }

  public async upsertReadiness(
    tx: PoolClient,
    claims: AuthClaims,
    cycleId: string,
    input: SubmissionReadinessInput,
    requestMeta: AuthRequestMeta,
  ): Promise<SubmissionReadinessResponse> {
    const actor = await this.resolveActor(tx, claims);
    if (!WRITE_ALLOWED_ROLES.has(actor.role)) {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const cycle = await this.repository.getCycleForUpdate(tx, claims.orgId, cycleId);
    if (!cycle) {
      throw AUTH_ERRORS.ASSESSMENT_CYCLE_NOT_FOUND();
    }
    if (cycle.status === "READY_FOR_SUBMISSION") {
      throw AUTH_ERRORS.SUBMISSION_READINESS_LOCKED();
    }
    if (cycle.status !== "FINALIZED_INTERNAL") {
      throw AUTH_ERRORS.SUBMISSION_READINESS_REQUIRES_FINALIZED_INTERNAL();
    }
    await assertCorrectionExecutionActiveForCycle(tx, cycle);

    const normalized = this.normalizeInput(input);
    const now = this.now();
    const readiness = await this.repository.upsertReadiness(tx, {
      orgId: claims.orgId,
      assessmentCycleId: cycle.id,
      reviewNotes: normalized.reviewNotes,
      confirmedAssessmentComplete: normalized.confirmedAssessmentComplete,
      confirmedEvidenceAttached: normalized.confirmedEvidenceAttached,
      confirmedEvidenceReviewed: normalized.confirmedEvidenceReviewed,
      confirmedScoreReviewed: normalized.confirmedScoreReviewed,
      confirmedAuthorizedSubmitter: normalized.confirmedAuthorizedSubmitter,
      confirmedInformationAccurate: normalized.confirmedInformationAccurate,
      declarationText: normalized.declarationText,
      declaredByUserId: claims.userId,
      declaredAt: now,
    });

    await this.repository.appendAuditEvent(tx, {
      eventType: "SUBMISSION_READINESS_UPSERTED",
      severity: "INFO",
      userId: claims.userId,
      orgId: claims.orgId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: {
        category: "submission_readiness_upserted",
        org_id: claims.orgId,
        assessment_cycle_id: cycle.id,
        actor_user_id: claims.userId,
        actor_org_id: claims.orgId,
        timestamp: now.toISOString(),
        request_ip: requestMeta.ipAddress,
        user_agent: requestMeta.userAgent,
      },
    });

    return this.toResponse(readiness);
  }

  public async markReadyForSubmission(
    tx: PoolClient,
    claims: AuthClaims,
    cycleId: string,
    requestMeta: AuthRequestMeta,
  ): Promise<MarkReadyResponse> {
    const actor = await this.resolveActor(tx, claims);
    if (actor.role !== "admin") {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const cycle = await this.repository.getCycleForUpdate(tx, claims.orgId, cycleId);
    if (!cycle) {
      throw AUTH_ERRORS.ASSESSMENT_CYCLE_NOT_FOUND();
    }
    if (cycle.status === "READY_FOR_SUBMISSION") {
      throw AUTH_ERRORS.SUBMISSION_READINESS_LOCKED();
    }
    if (cycle.status !== "FINALIZED_INTERNAL") {
      throw AUTH_ERRORS.SUBMISSION_READINESS_REQUIRES_FINALIZED_INTERNAL();
    }
    await assertCorrectionExecutionActiveForCycle(tx, cycle);

    const readiness = await this.repository.getReadinessByCycle(
      claims.orgId,
      cycle.id,
      tx,
    );
    if (!readiness) {
      throw AUTH_ERRORS.SUBMISSION_READINESS_NOT_FOUND();
    }
    this.assertReadinessComplete(readiness);

    const score = await this.repository.getScoreSnapshotForCycle(
      tx,
      claims.orgId,
      cycle.id,
    );
    if (!score) {
      throw AUTH_ERRORS.ASSESSMENT_SCORE_REQUIRED();
    }
    this.assertFreshScore(score, cycle.finalized_internal_at);

    const updated = await this.repository.markReadyForSubmission(tx, {
      cycleId: cycle.id,
    });
    if (!updated) {
      throw AUTH_ERRORS.CONFLICT();
    }

    const now = this.now();
    await this.repository.appendAuditEvent(tx, {
      eventType: "ASSESSMENT_MARKED_READY_FOR_SUBMISSION",
      severity: "INFO",
      userId: claims.userId,
      orgId: claims.orgId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: {
        category: "assessment_marked_ready_for_submission",
        org_id: claims.orgId,
        assessment_cycle_id: cycle.id,
        previous_status: "FINALIZED_INTERNAL",
        new_status: "READY_FOR_SUBMISSION",
        score_snapshot_id: score.id,
        overall_score: score.overall_score === null ? null : Number(score.overall_score),
        overall_label: score.overall_label,
        actor_user_id: claims.userId,
        actor_org_id: claims.orgId,
        timestamp: now.toISOString(),
        request_ip: requestMeta.ipAddress,
        user_agent: requestMeta.userAgent,
      },
    });

    return {
      id: updated.id,
      orgId: updated.org_id,
      status: "READY_FOR_SUBMISSION",
      finalizedInternalAt: updated.finalized_internal_at,
      scoreSnapshotId: score.id,
      overallScore: score.overall_score,
      overallLabel: score.overall_label,
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

  private normalizeInput(input: SubmissionReadinessInput): {
    confirmedAssessmentComplete: boolean;
    confirmedEvidenceAttached: boolean;
    confirmedEvidenceReviewed: boolean;
    confirmedScoreReviewed: boolean;
    confirmedAuthorizedSubmitter: boolean;
    confirmedInformationAccurate: boolean;
    declarationText: string;
    reviewNotes: string | null;
  } {
    return {
      confirmedAssessmentComplete: this.requiredBoolean(
        input.confirmedAssessmentComplete,
      ),
      confirmedEvidenceAttached: this.requiredBoolean(input.confirmedEvidenceAttached),
      confirmedEvidenceReviewed: this.requiredBoolean(input.confirmedEvidenceReviewed),
      confirmedScoreReviewed: this.requiredBoolean(input.confirmedScoreReviewed),
      confirmedAuthorizedSubmitter: this.requiredBoolean(
        input.confirmedAuthorizedSubmitter,
      ),
      confirmedInformationAccurate: this.requiredBoolean(
        input.confirmedInformationAccurate,
      ),
      declarationText: this.normalizeDeclaration(input.declarationText),
      reviewNotes: this.normalizeReviewNotes(input.reviewNotes),
    };
  }

  private requiredBoolean(value: unknown): boolean {
    if (typeof value !== "boolean") {
      throw AUTH_ERRORS.INVALID_SUBMISSION_READINESS();
    }
    return value;
  }

  private normalizeDeclaration(value: unknown): string {
    if (typeof value !== "string") {
      throw AUTH_ERRORS.INVALID_SUBMISSION_READINESS();
    }
    const trimmed = value.trim();
    if (trimmed.length < 50 || trimmed.length > 2000) {
      throw AUTH_ERRORS.INVALID_SUBMISSION_READINESS();
    }
    return trimmed;
  }

  private normalizeReviewNotes(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== "string" || value.length > 5000) {
      throw AUTH_ERRORS.INVALID_SUBMISSION_READINESS();
    }
    return value;
  }

  private assertReadinessComplete(record: SubmissionReadinessRecord): void {
    if (
      !record.confirmed_assessment_complete ||
      !record.confirmed_evidence_attached ||
      !record.confirmed_evidence_reviewed ||
      !record.confirmed_score_reviewed ||
      !record.confirmed_authorized_submitter ||
      !record.confirmed_information_accurate ||
      record.declaration_text.trim().length < 50 ||
      record.declaration_text.trim().length > 2000 ||
      !record.declared_by_user_id ||
      !record.declared_at
    ) {
      throw AUTH_ERRORS.SUBMISSION_READINESS_INCOMPLETE();
    }
  }

  private assertFreshScore(
    score: ScoreSnapshotForReadiness,
    finalizedInternalAt: Date | null,
  ): void {
    if (!score.calculated_at || !finalizedInternalAt) {
      throw AUTH_ERRORS.ASSESSMENT_SCORE_STALE();
    }
    if (score.calculated_at.getTime() < finalizedInternalAt.getTime()) {
      throw AUTH_ERRORS.ASSESSMENT_SCORE_STALE();
    }
  }

  private toResponse(record: SubmissionReadinessRecord): SubmissionReadinessResponse {
    return {
      id: record.id,
      orgId: record.org_id,
      assessmentCycleId: record.assessment_cycle_id,
      reviewNotes: record.review_notes,
      confirmedAssessmentComplete: record.confirmed_assessment_complete,
      confirmedEvidenceAttached: record.confirmed_evidence_attached,
      confirmedEvidenceReviewed: record.confirmed_evidence_reviewed,
      confirmedScoreReviewed: record.confirmed_score_reviewed,
      confirmedAuthorizedSubmitter: record.confirmed_authorized_submitter,
      confirmedInformationAccurate: record.confirmed_information_accurate,
      declarationText: record.declaration_text,
      declaredByUserId: record.declared_by_user_id,
      declaredAt: record.declared_at,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }
}

export type {
  MarkReadyResponse,
  SubmissionReadinessInput,
  SubmissionReadinessResponse,
};
