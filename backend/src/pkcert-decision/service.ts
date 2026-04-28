import type { PoolClient } from "pg";

import { AUTH_ERRORS } from "../auth/errors.js";
import type { AuthClaims, AuthRequestMeta } from "../auth/types.js";
import {
  PkcertDecisionRepository,
  type DecisionRecord,
  type PkcertDecision,
  type PkcertUser,
} from "./repository.js";

type DecisionCreateResponse = {
  id: string;
  externalSubmissionId: string;
  intakeReviewId: string;
  orgId: string;
  assessmentCycleId: string;
  submissionPackageId: string;
  decision: PkcertDecision;
  decisionReason: string;
  decidedByUserId: string;
  decidedAt: Date;
  internalNotes: string | null;
  intakeStatus: string;
  createdAt: Date;
  updatedAt: Date;
};

type OrganizationDecisionResponse = {
  externalSubmissionId: string;
  assessmentCycleId: string;
  submissionPackageId: string;
  decision: PkcertDecision;
  decisionReason: string;
  decidedAt: Date;
};

type ServiceOptions = {
  repository: PkcertDecisionRepository;
  now?: () => Date;
};

export class PkcertDecisionService {
  private readonly repository: PkcertDecisionRepository;
  private readonly now: () => Date;

  public constructor(options: ServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
  }

  public async createDecision(
    tx: PoolClient,
    claims: AuthClaims,
    externalSubmissionId: string,
    input: { decision?: unknown; decisionReason?: unknown },
    requestMeta: AuthRequestMeta,
  ): Promise<DecisionCreateResponse> {
    const actor = await this.resolvePkcertActor(tx, claims);
    if (actor.pkcert_role !== "PKCERT_ADMIN") {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const externalSubmission =
      await this.repository.getExternalSubmissionForDecisionUpdate(
        tx,
        externalSubmissionId,
      );
    if (!externalSubmission) {
      throw AUTH_ERRORS.EXTERNAL_SUBMISSION_NOT_FOUND();
    }
    if (externalSubmission.status === "WITHDRAWN") {
      throw AUTH_ERRORS.EXTERNAL_SUBMISSION_WITHDRAWN();
    }
    if (externalSubmission.status !== "SUBMITTED") {
      throw AUTH_ERRORS.CONFLICT();
    }

    const intake = await this.repository.getIntakeForDecisionUpdate(
      tx,
      externalSubmissionId,
    );
    if (!intake || intake.status !== "INTAKE_REVIEWED") {
      throw AUTH_ERRORS.PKCERT_DECISION_REQUIRES_INTAKE_REVIEWED();
    }

    const existing = await this.repository.decisionExistsForSubmission(
      externalSubmission.org_id,
      externalSubmission.id,
      tx,
    );
    if (existing) {
      throw AUTH_ERRORS.PKCERT_DECISION_ALREADY_EXISTS();
    }

    const decision = this.normalizeDecision(input.decision);
    const decisionReason = this.normalizeDecisionReason(input.decisionReason);
    const now = this.now();
    const created = await this.repository.insertDecision(tx, {
      externalSubmissionId: externalSubmission.id,
      intakeReviewId: intake.id,
      orgId: externalSubmission.org_id,
      assessmentCycleId: externalSubmission.assessment_cycle_id,
      submissionPackageId: externalSubmission.submission_package_id,
      decision,
      decisionReason,
      decidedByUserId: claims.userId,
      decidedAt: now,
    });

    await this.repository.appendAuditEvent(tx, {
      eventType: "PKCERT_DECISION_RECORDED",
      severity: "INFO",
      userId: claims.userId,
      orgId: claims.orgId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: {
        category: "pkcert_decision_recorded",
        org_id: externalSubmission.org_id,
        external_submission_id: externalSubmission.id,
        intake_review_id: intake.id,
        decision_id: created.id,
        decision,
        decision_reason: decisionReason,
        submission_package_id: externalSubmission.submission_package_id,
        assessment_cycle_id: externalSubmission.assessment_cycle_id,
        actor_user_id: claims.userId,
        actor_org_id: claims.orgId,
        pkcert_role: actor.pkcert_role,
        timestamp: now.toISOString(),
        request_ip: requestMeta.ipAddress,
        user_agent: requestMeta.userAgent,
      },
    });

    return this.toPkcertResponse({
      ...created,
      intake_status: intake.status,
      internal_notes: intake.internal_notes,
    });
  }

  public async getDecisionForPkcert(
    tx: PoolClient,
    claims: AuthClaims,
    externalSubmissionId: string,
  ): Promise<DecisionCreateResponse> {
    await this.resolvePkcertActor(tx, claims);
    const decision = await this.repository.getDecisionForPkcert(
      externalSubmissionId,
      tx,
    );
    if (!decision) {
      throw AUTH_ERRORS.PKCERT_DECISION_NOT_FOUND();
    }
    return this.toPkcertResponse(decision);
  }

  public async getDecisionForOrganization(
    tx: PoolClient,
    claims: AuthClaims,
    externalSubmissionId: string,
  ): Promise<OrganizationDecisionResponse> {
    const decision = await this.repository.getDecisionForOrg(
      claims.orgId,
      externalSubmissionId,
      tx,
    );
    if (!decision) {
      throw AUTH_ERRORS.PKCERT_DECISION_NOT_FOUND();
    }
    return {
      externalSubmissionId: decision.external_submission_id,
      assessmentCycleId: decision.assessment_cycle_id,
      submissionPackageId: decision.submission_package_id,
      decision: decision.decision,
      decisionReason: decision.decision_reason,
      decidedAt: decision.decided_at,
    };
  }

  private async resolvePkcertActor(
    tx: PoolClient,
    claims: AuthClaims,
  ): Promise<PkcertUser> {
    const actor = await this.repository.findPkcertUser(tx, claims.userId);
    if (!actor || !actor.is_active) {
      throw AUTH_ERRORS.PKCERT_ACCESS_REQUIRED();
    }
    return actor;
  }

  private normalizeDecision(value: unknown): PkcertDecision {
    if (
      value === "ACCEPTED" ||
      value === "REJECTED" ||
      value === "RETURNED_FOR_CORRECTION"
    ) {
      return value;
    }
    throw AUTH_ERRORS.INVALID_PKCERT_DECISION();
  }

  private normalizeDecisionReason(value: unknown): string {
    if (typeof value !== "string") {
      throw AUTH_ERRORS.INVALID_PKCERT_DECISION();
    }
    const trimmed = value.trim();
    if (trimmed.length < 20 || trimmed.length > 5000) {
      throw AUTH_ERRORS.INVALID_PKCERT_DECISION();
    }
    return trimmed;
  }

  private toPkcertResponse(record: DecisionRecord): DecisionCreateResponse {
    return {
      id: record.id,
      externalSubmissionId: record.external_submission_id,
      intakeReviewId: record.intake_review_id,
      orgId: record.org_id,
      assessmentCycleId: record.assessment_cycle_id,
      submissionPackageId: record.submission_package_id,
      decision: record.decision,
      decisionReason: record.decision_reason,
      decidedByUserId: record.decided_by_user_id,
      decidedAt: record.decided_at,
      internalNotes: record.internal_notes ?? null,
      intakeStatus: record.intake_status ?? "INTAKE_REVIEWED",
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }
}

export type { DecisionCreateResponse, OrganizationDecisionResponse };
