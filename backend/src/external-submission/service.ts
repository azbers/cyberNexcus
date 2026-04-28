import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";

import { AUTH_ERRORS } from "../auth/errors.js";
import type { AuthClaims, AuthRequestMeta } from "../auth/types.js";
import { PkcertDecisionRepository } from "../pkcert-decision/repository.js";
import { PkcertIntakeRepository } from "../pkcert-intake/repository.js";
import { manifestHashFor } from "../submission-package/service.js";
import {
  ExternalSubmissionRepository,
  type ExternalSubmissionRecord,
  type ExternalSubmissionStatus,
  type PackageForExternalSubmission,
} from "./repository.js";

type PaginationInput = {
  page?: number;
  pageSize?: number;
  status?: string;
};

type PaginatedResponse<T> = {
  page: number;
  pageSize: number;
  total: number;
  items: T[];
};

type ExternalSubmissionResponse = {
  id: string;
  orgId: string;
  submissionPackageId: string;
  assessmentCycleId: string;
  submissionNumber: string;
  status: ExternalSubmissionStatus;
  submittedByUserId: string;
  submittedAt: Date;
  withdrawnByUserId: string | null;
  withdrawnAt: Date | null;
  withdrawReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type ServiceOptions = {
  repository: ExternalSubmissionRepository;
  pkcertIntakeRepository?: PkcertIntakeRepository;
  pkcertDecisionRepository?: PkcertDecisionRepository;
  now?: () => Date;
};

type PgError = Error & {
  code?: string;
  constraint?: string;
};

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_SUBMISSION_NUMBER_ATTEMPTS = 5;

export class ExternalSubmissionService {
  private readonly repository: ExternalSubmissionRepository;
  private readonly pkcertIntakeRepository?: PkcertIntakeRepository;
  private readonly pkcertDecisionRepository?: PkcertDecisionRepository;
  private readonly now: () => Date;

  public constructor(options: ServiceOptions) {
    this.repository = options.repository;
    this.pkcertIntakeRepository = options.pkcertIntakeRepository;
    this.pkcertDecisionRepository = options.pkcertDecisionRepository;
    this.now = options.now ?? (() => new Date());
  }

  public async submitPackage(
    tx: PoolClient,
    claims: AuthClaims,
    packageId: string,
    requestMeta: AuthRequestMeta,
  ): Promise<ExternalSubmissionResponse> {
    const actor = await this.resolveActor(tx, claims);
    if (actor.role !== "admin") {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const pkg = await this.repository.getPackageForSubmitUpdate(
      tx,
      claims.orgId,
      packageId,
    );
    if (!pkg) {
      throw AUTH_ERRORS.SUBMISSION_PACKAGE_NOT_FOUND();
    }
    if (pkg.status !== "CREATED") {
      throw AUTH_ERRORS.SUBMISSION_PACKAGE_NOT_SUBMITTABLE();
    }
    if (pkg.cycle_status !== "READY_FOR_SUBMISSION") {
      throw AUTH_ERRORS.SUBMISSION_PACKAGE_REQUIRES_READY_FOR_SUBMISSION();
    }
    if (manifestHashFor(pkg.manifest_json) !== pkg.manifest_hash) {
      throw AUTH_ERRORS.SUBMISSION_PACKAGE_INTEGRITY_FAILED();
    }

    const active = await this.repository.getActiveSubmissionByPackage(
      claims.orgId,
      pkg.id,
      tx,
    );
    if (active) {
      throw AUTH_ERRORS.EXTERNAL_SUBMISSION_ALREADY_EXISTS();
    }

    const now = this.now();
    const created = await this.insertSubmissionWithRetry(tx, claims, pkg, now);

    if (this.pkcertIntakeRepository) {
      const intake = await this.pkcertIntakeRepository.createIntakeReview(tx, {
        externalSubmissionId: created.id,
        orgId: claims.orgId,
        assessmentCycleId: pkg.assessment_cycle_id,
        submissionPackageId: pkg.id,
      });
      await this.pkcertIntakeRepository.appendAuditEvent(tx, {
        eventType: "PKCERT_INTAKE_CREATED",
        severity: "INFO",
        userId: claims.userId,
        orgId: claims.orgId,
        ipAddress: requestMeta.ipAddress,
        userAgent: requestMeta.userAgent,
        metadata: {
          category: "pkcert_intake_created",
          org_id: claims.orgId,
          external_submission_id: created.id,
          intake_review_id: intake.id,
          submission_package_id: pkg.id,
          assessment_cycle_id: pkg.assessment_cycle_id,
          actor_type: "SYSTEM",
          actor_user_id: null,
          actor_org_id: null,
          pkcert_role: null,
          triggered_by_user_id: claims.userId,
          triggered_by_org_id: claims.orgId,
          trigger_event: "EXTERNAL_SUBMISSION_CREATED",
          timestamp: now.toISOString(),
          request_ip: requestMeta.ipAddress,
          user_agent: requestMeta.userAgent,
        },
      });
    }

    await this.repository.appendAuditEvent(tx, {
      eventType: "EXTERNAL_SUBMISSION_CREATED",
      severity: "INFO",
      userId: claims.userId,
      orgId: claims.orgId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: {
        category: "external_submission_created",
        org_id: claims.orgId,
        external_submission_id: created.id,
        submission_number: created.submission_number,
        submission_package_id: pkg.id,
        assessment_cycle_id: pkg.assessment_cycle_id,
        package_number: pkg.package_number,
        manifest_hash: pkg.manifest_hash,
        actor_user_id: claims.userId,
        actor_org_id: claims.orgId,
        timestamp: now.toISOString(),
        request_ip: requestMeta.ipAddress,
        user_agent: requestMeta.userAgent,
      },
    });

    return this.toResponse(created);
  }

  public async withdrawSubmission(
    tx: PoolClient,
    claims: AuthClaims,
    submissionId: string,
    reasonInput: unknown,
    requestMeta: AuthRequestMeta,
  ): Promise<ExternalSubmissionResponse> {
    const actor = await this.resolveActor(tx, claims);
    if (actor.role !== "admin") {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const existing = await this.repository.getSubmissionForWithdrawUpdate(
      tx,
      claims.orgId,
      submissionId,
    );
    if (!existing) {
      throw AUTH_ERRORS.EXTERNAL_SUBMISSION_NOT_FOUND();
    }
    if (existing.status !== "SUBMITTED") {
      throw AUTH_ERRORS.CONFLICT();
    }
    if (
      this.pkcertDecisionRepository &&
      await this.pkcertDecisionRepository.decisionExistsForSubmission(
        claims.orgId,
        existing.id,
        tx,
      )
    ) {
      throw AUTH_ERRORS.EXTERNAL_SUBMISSION_DECIDED();
    }

    const reason = this.normalizeWithdrawReason(reasonInput);
    const now = this.now();
    const withdrawn = await this.repository.withdrawSubmission(tx, {
      orgId: claims.orgId,
      submissionId: existing.id,
      withdrawnByUserId: claims.userId,
      withdrawnAt: now,
      withdrawReason: reason,
    });
    if (!withdrawn) {
      throw AUTH_ERRORS.CONFLICT();
    }

    await this.repository.appendAuditEvent(tx, {
      eventType: "EXTERNAL_SUBMISSION_WITHDRAWN",
      severity: "INFO",
      userId: claims.userId,
      orgId: claims.orgId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: {
        category: "external_submission_withdrawn",
        org_id: claims.orgId,
        external_submission_id: existing.id,
        submission_number: existing.submission_number,
        submission_package_id: existing.submission_package_id,
        assessment_cycle_id: existing.assessment_cycle_id,
        reason,
        actor_user_id: claims.userId,
        actor_org_id: claims.orgId,
        timestamp: now.toISOString(),
        request_ip: requestMeta.ipAddress,
        user_agent: requestMeta.userAgent,
      },
    });

    return this.toResponse(withdrawn);
  }

  public async getSubmissionById(
    tx: PoolClient,
    claims: AuthClaims,
    submissionId: string,
  ): Promise<ExternalSubmissionResponse> {
    await this.resolveActor(tx, claims);
    const record = await this.repository.getSubmissionById(
      claims.orgId,
      submissionId,
      tx,
    );
    if (!record) {
      throw AUTH_ERRORS.EXTERNAL_SUBMISSION_NOT_FOUND();
    }
    return this.toResponse(record);
  }

  public async listSubmissionsByPackage(
    tx: PoolClient,
    claims: AuthClaims,
    packageId: string,
    input: PaginationInput,
  ): Promise<PaginatedResponse<ExternalSubmissionResponse>> {
    await this.resolveActor(tx, claims);
    const exists = await this.repository.packageExistsForOrg(claims.orgId, packageId, tx);
    if (!exists) {
      throw AUTH_ERRORS.SUBMISSION_PACKAGE_NOT_FOUND();
    }
    const page = this.normalizePage(input.page);
    const pageSize = this.normalizePageSize(input.pageSize);
    const status = this.normalizeStatusFilter(input.status);
    const result = await this.repository.listSubmissionsByPackage(
      claims.orgId,
      packageId,
      status,
      pageSize,
      (page - 1) * pageSize,
      tx,
    );
    return {
      page,
      pageSize,
      total: result.total,
      items: result.items.map((item) => this.toResponse(item)),
    };
  }

  public async listSubmissionsByCycle(
    tx: PoolClient,
    claims: AuthClaims,
    cycleId: string,
    input: PaginationInput,
  ): Promise<PaginatedResponse<ExternalSubmissionResponse>> {
    await this.resolveActor(tx, claims);
    const exists = await this.repository.cycleExistsForOrg(claims.orgId, cycleId, tx);
    if (!exists) {
      throw AUTH_ERRORS.ASSESSMENT_CYCLE_NOT_FOUND();
    }
    const page = this.normalizePage(input.page);
    const pageSize = this.normalizePageSize(input.pageSize);
    const status = this.normalizeStatusFilter(input.status);
    const result = await this.repository.listSubmissionsByCycle(
      claims.orgId,
      cycleId,
      status,
      pageSize,
      (page - 1) * pageSize,
      tx,
    );
    return {
      page,
      pageSize,
      total: result.total,
      items: result.items.map((item) => this.toResponse(item)),
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

  private async insertSubmissionWithRetry(
    tx: PoolClient,
    claims: AuthClaims,
    pkg: PackageForExternalSubmission,
    submittedAt: Date,
  ): Promise<ExternalSubmissionRecord> {
    for (let attempt = 0; attempt < MAX_SUBMISSION_NUMBER_ATTEMPTS; attempt += 1) {
      try {
        return await this.repository.insertSubmission(tx, {
          orgId: claims.orgId,
          submissionPackageId: pkg.id,
          assessmentCycleId: pkg.assessment_cycle_id,
          submissionNumber: this.generateSubmissionNumber(submittedAt),
          submittedByUserId: claims.userId,
          submittedAt,
        });
      } catch (err) {
        const pgErr = err as PgError;
        if (pgErr.code !== "23505") {
          throw err;
        }
        const active = await this.repository.getActiveSubmissionByPackage(
          claims.orgId,
          pkg.id,
          tx,
        );
        if (
          active ||
          pgErr.constraint === "uq_external_submissions_one_submitted_per_package"
        ) {
          throw AUTH_ERRORS.EXTERNAL_SUBMISSION_ALREADY_EXISTS();
        }
      }
    }
    throw AUTH_ERRORS.CONFLICT();
  }

  private generateSubmissionNumber(now: Date): string {
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    return `EXT-${yyyy}${mm}${dd}-${randomBytes(4).toString("hex").toUpperCase()}`;
  }

  private normalizeWithdrawReason(value: unknown): string {
    if (typeof value !== "string") {
      throw AUTH_ERRORS.INVALID_EXTERNAL_SUBMISSION_WITHDRAW_REASON();
    }
    const trimmed = value.trim();
    if (trimmed.length < 10 || trimmed.length > 2000) {
      throw AUTH_ERRORS.INVALID_EXTERNAL_SUBMISSION_WITHDRAW_REASON();
    }
    return trimmed;
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

  private normalizeStatusFilter(status?: string): ExternalSubmissionStatus | null {
    if (!status) {
      return null;
    }
    if (status === "SUBMITTED" || status === "WITHDRAWN") {
      return status;
    }
    throw AUTH_ERRORS.INVALID_EXTERNAL_SUBMISSION_STATUS_FILTER();
  }

  private toResponse(record: ExternalSubmissionRecord): ExternalSubmissionResponse {
    return {
      id: record.id,
      orgId: record.org_id,
      submissionPackageId: record.submission_package_id,
      assessmentCycleId: record.assessment_cycle_id,
      submissionNumber: record.submission_number,
      status: record.status,
      submittedByUserId: record.submitted_by_user_id,
      submittedAt: record.submitted_at,
      withdrawnByUserId: record.withdrawn_by_user_id,
      withdrawnAt: record.withdrawn_at,
      withdrawReason: record.withdraw_reason,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }
}

export type { ExternalSubmissionResponse, PaginationInput };
