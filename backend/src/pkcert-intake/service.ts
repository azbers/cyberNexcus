import type { PoolClient } from "pg";

import { AUTH_ERRORS } from "../auth/errors.js";
import type { AuthClaims, AuthRequestMeta } from "../auth/types.js";
import {
  PkcertIntakeRepository,
  type IntakeReviewRecord,
  type IntakeStatus,
  type PkcertRole,
  type PkcertUser,
} from "./repository.js";

type PaginationInput = {
  page?: number;
  pageSize?: number;
  status?: string;
  assignedToMe?: boolean;
};

type PaginatedResponse<T> = {
  page: number;
  pageSize: number;
  total: number;
  items: T[];
};

type IntakeReviewResponse = {
  id: string;
  externalSubmissionId: string;
  orgId: string;
  assessmentCycleId: string;
  submissionPackageId: string;
  status: IntakeStatus;
  assignedToUserId: string | null;
  assignedAt: Date | null;
  startedByUserId: string | null;
  startedAt: Date | null;
  reviewedByUserId: string | null;
  reviewedAt: Date | null;
  internalNotes: string | null;
  externalSubmissionStatus: "SUBMITTED" | "WITHDRAWN";
  createdAt: Date;
  updatedAt: Date;
};

type ServiceOptions = {
  repository: PkcertIntakeRepository;
  now?: () => Date;
};

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export class PkcertIntakeService {
  private readonly repository: PkcertIntakeRepository;
  private readonly now: () => Date;

  public constructor(options: ServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
  }

  public async listIntakeReviews(
    tx: PoolClient,
    claims: AuthClaims,
    input: PaginationInput,
  ): Promise<PaginatedResponse<IntakeReviewResponse>> {
    const actor = await this.resolvePkcertActor(tx, claims);
    const page = this.normalizePage(input.page);
    const pageSize = this.normalizePageSize(input.pageSize);
    const status = this.normalizeStatusFilter(input.status);
    const assignedToUserId = input.assignedToMe ? actor.user_id : null;

    const result = await this.repository.listIntakeReviews(
      {
        status,
        assignedToUserId,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      },
      tx,
    );
    return {
      page,
      pageSize,
      total: result.total,
      items: result.items.map((item) => this.toResponse(item)),
    };
  }

  public async getIntakeReview(
    tx: PoolClient,
    claims: AuthClaims,
    externalSubmissionId: string,
  ): Promise<IntakeReviewResponse> {
    await this.resolvePkcertActor(tx, claims);
    const intake = await this.repository.getIntakeByExternalSubmissionId(
      externalSubmissionId,
      tx,
    );
    if (!intake) {
      throw AUTH_ERRORS.PKCERT_INTAKE_NOT_FOUND();
    }
    return this.toResponse(intake);
  }

  public async assignReviewer(
    tx: PoolClient,
    claims: AuthClaims,
    externalSubmissionId: string,
    reviewerUserIdInput: unknown,
    requestMeta: AuthRequestMeta,
  ): Promise<IntakeReviewResponse> {
    const actor = await this.resolvePkcertActor(tx, claims);
    this.requireAdmin(actor);
    const reviewerUserId = this.normalizeReviewerUserId(reviewerUserIdInput);
    const reviewer = await this.repository.findPkcertUser(tx, reviewerUserId);
    if (!reviewer || !reviewer.is_active) {
      throw AUTH_ERRORS.PKCERT_REVIEWER_NOT_FOUND();
    }

    const intake = await this.getMutableIntake(tx, externalSubmissionId);
    const now = this.now();
    const updated = await this.repository.assignReviewer(tx, {
      intakeReviewId: intake.id,
      reviewerUserId,
      assignedAt: now,
    });
    if (!updated) {
      throw AUTH_ERRORS.CONFLICT();
    }

    await this.auditPkcertMutation(tx, {
      eventType: "PKCERT_INTAKE_ASSIGNED",
      actor,
      claims,
      requestMeta,
      intake: updated,
      now,
      extraMetadata: { assigned_to_user_id: reviewerUserId },
    });

    return this.toResponse(updated);
  }

  public async startReview(
    tx: PoolClient,
    claims: AuthClaims,
    externalSubmissionId: string,
    requestMeta: AuthRequestMeta,
  ): Promise<IntakeReviewResponse> {
    const actor = await this.resolvePkcertActor(tx, claims);
    const intake = await this.getMutableIntake(tx, externalSubmissionId);
    if (intake.status !== "PENDING_INTAKE") {
      throw AUTH_ERRORS.INVALID_PKCERT_INTAKE_STATUS();
    }
    const actorIsAdmin = actor.pkcert_role === "PKCERT_ADMIN";
    if (!actorIsAdmin && intake.assigned_to_user_id !== actor.user_id) {
      throw AUTH_ERRORS.PKCERT_INTAKE_NOT_ASSIGNED();
    }

    const now = this.now();
    const updated = await this.repository.startReview(tx, {
      intakeReviewId: intake.id,
      actorUserId: actor.user_id,
      startedAt: now,
      assignToActorIfUnassigned: actorIsAdmin && !intake.assigned_to_user_id,
    });
    if (!updated) {
      throw AUTH_ERRORS.INVALID_PKCERT_INTAKE_STATUS();
    }

    await this.auditPkcertMutation(tx, {
      eventType: "PKCERT_INTAKE_STARTED",
      actor,
      claims,
      requestMeta,
      intake: updated,
      now,
    });

    return this.toResponse(updated);
  }

  public async markReviewed(
    tx: PoolClient,
    claims: AuthClaims,
    externalSubmissionId: string,
    requestMeta: AuthRequestMeta,
  ): Promise<IntakeReviewResponse> {
    const actor = await this.resolvePkcertActor(tx, claims);
    const intake = await this.getMutableIntake(tx, externalSubmissionId);
    if (intake.status !== "IN_INTAKE_REVIEW") {
      throw AUTH_ERRORS.INVALID_PKCERT_INTAKE_STATUS();
    }
    if (
      actor.pkcert_role !== "PKCERT_ADMIN" &&
      intake.assigned_to_user_id !== actor.user_id
    ) {
      throw AUTH_ERRORS.PKCERT_INTAKE_NOT_ASSIGNED();
    }

    const now = this.now();
    const updated = await this.repository.markReviewed(tx, {
      intakeReviewId: intake.id,
      actorUserId: actor.user_id,
      reviewedAt: now,
    });
    if (!updated) {
      throw AUTH_ERRORS.INVALID_PKCERT_INTAKE_STATUS();
    }

    await this.auditPkcertMutation(tx, {
      eventType: "PKCERT_INTAKE_REVIEWED",
      actor,
      claims,
      requestMeta,
      intake: updated,
      now,
    });

    return this.toResponse(updated);
  }

  public async updateNotes(
    tx: PoolClient,
    claims: AuthClaims,
    externalSubmissionId: string,
    internalNotesInput: unknown,
    requestMeta: AuthRequestMeta,
  ): Promise<IntakeReviewResponse> {
    const actor = await this.resolvePkcertActor(tx, claims);
    const intake = await this.getMutableIntake(tx, externalSubmissionId);
    if (
      actor.pkcert_role !== "PKCERT_ADMIN" &&
      intake.assigned_to_user_id !== actor.user_id
    ) {
      throw AUTH_ERRORS.PKCERT_INTAKE_NOT_ASSIGNED();
    }
    const internalNotes = this.normalizeNotes(internalNotesInput);

    const now = this.now();
    const updated = await this.repository.updateNotes(tx, {
      intakeReviewId: intake.id,
      internalNotes,
    });
    if (!updated) {
      throw AUTH_ERRORS.CONFLICT();
    }

    await this.auditPkcertMutation(tx, {
      eventType: "PKCERT_INTAKE_NOTES_UPDATED",
      actor,
      claims,
      requestMeta,
      intake: updated,
      now,
    });

    return this.toResponse(updated);
  }

  private async getMutableIntake(
    tx: PoolClient,
    externalSubmissionId: string,
  ): Promise<IntakeReviewRecord> {
    const intake = await this.repository.getIntakeForUpdate(tx, externalSubmissionId);
    if (!intake) {
      throw AUTH_ERRORS.PKCERT_INTAKE_NOT_FOUND();
    }
    if (intake.external_submission_status === "WITHDRAWN") {
      throw AUTH_ERRORS.EXTERNAL_SUBMISSION_WITHDRAWN();
    }
    return intake;
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

  private requireAdmin(actor: PkcertUser): void {
    if (actor.pkcert_role !== "PKCERT_ADMIN") {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }
  }

  private normalizeReviewerUserId(value: unknown): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw AUTH_ERRORS.PKCERT_REVIEWER_NOT_FOUND();
    }
    return value.trim();
  }

  private normalizeNotes(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== "string") {
      throw AUTH_ERRORS.INVALID_PKCERT_INTAKE_NOTES();
    }
    if (value.length > 5000) {
      throw AUTH_ERRORS.INVALID_PKCERT_INTAKE_NOTES();
    }
    return value;
  }

  private normalizeStatusFilter(status?: string): IntakeStatus | null {
    if (!status) {
      return null;
    }
    if (
      status === "PENDING_INTAKE" ||
      status === "IN_INTAKE_REVIEW" ||
      status === "INTAKE_REVIEWED"
    ) {
      return status;
    }
    throw AUTH_ERRORS.INVALID_PKCERT_INTAKE_STATUS_FILTER();
  }

  private normalizePage(page?: number): number {
    if (!Number.isFinite(page) || !page || page < 1) {
      return DEFAULT_PAGE;
    }
    return Math.floor(page);
  }

  private normalizePageSize(pageSize?: number): number {
    if (!Number.isFinite(pageSize) || !pageSize || pageSize < 1) {
      return DEFAULT_PAGE_SIZE;
    }
    return Math.min(Math.floor(pageSize), MAX_PAGE_SIZE);
  }

  private async auditPkcertMutation(
    tx: PoolClient,
    input: {
      eventType:
        | "PKCERT_INTAKE_ASSIGNED"
        | "PKCERT_INTAKE_STARTED"
        | "PKCERT_INTAKE_REVIEWED"
        | "PKCERT_INTAKE_NOTES_UPDATED";
      actor: PkcertUser;
      claims: AuthClaims;
      requestMeta: AuthRequestMeta;
      intake: IntakeReviewRecord;
      now: Date;
      extraMetadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.repository.appendAuditEvent(tx, {
      eventType: input.eventType,
      severity: "INFO",
      userId: input.claims.userId,
      orgId: input.claims.orgId,
      ipAddress: input.requestMeta.ipAddress,
      userAgent: input.requestMeta.userAgent,
      metadata: {
        category: input.eventType.toLowerCase(),
        org_id: input.intake.org_id,
        external_submission_id: input.intake.external_submission_id,
        intake_review_id: input.intake.id,
        submission_package_id: input.intake.submission_package_id,
        assessment_cycle_id: input.intake.assessment_cycle_id,
        actor_type: "USER",
        actor_user_id: input.claims.userId,
        actor_org_id: input.claims.orgId,
        pkcert_role: input.actor.pkcert_role,
        timestamp: input.now.toISOString(),
        request_ip: input.requestMeta.ipAddress,
        user_agent: input.requestMeta.userAgent,
        ...(input.extraMetadata ?? {}),
      },
    });
  }

  private toResponse(record: IntakeReviewRecord): IntakeReviewResponse {
    return {
      id: record.id,
      externalSubmissionId: record.external_submission_id,
      orgId: record.org_id,
      assessmentCycleId: record.assessment_cycle_id,
      submissionPackageId: record.submission_package_id,
      status: record.status,
      assignedToUserId: record.assigned_to_user_id,
      assignedAt: record.assigned_at,
      startedByUserId: record.started_by_user_id,
      startedAt: record.started_at,
      reviewedByUserId: record.reviewed_by_user_id,
      reviewedAt: record.reviewed_at,
      internalNotes: record.internal_notes,
      externalSubmissionStatus: record.external_submission_status,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }
}

export type { IntakeReviewResponse, PaginationInput };
