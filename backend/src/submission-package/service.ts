import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";

import { AUTH_ERRORS } from "../auth/errors.js";
import type { AuthClaims, AuthRequestMeta } from "../auth/types.js";
import { assertCorrectionExecutionActiveForCycle } from "../correction-execution/guard.js";
import {
  SubmissionPackageRepository,
  type PackageManifestCounts,
  type ScoreSnapshotForPackage,
  type SubmissionPackageRecord,
} from "./repository.js";

type PackageManifest = {
  packageVersion: "SUBMISSION_PACKAGE_V1";
  orgId: string;
  assessmentCycleId: string;
  scoreSnapshotId: string;
  readinessId: string;
  createdAt: string;
  createdByUserId: string;
  assessmentStatus: "READY_FOR_SUBMISSION";
  scoringVersion: string;
  overallScore: number | null;
  overallLabel: string | null;
  counts: {
    totalRequirements: number;
    applicableRequirements: number;
    notApplicableRequirements: number;
    evidenceFiles: number;
    checklists: number;
  };
  hashes: {
    manifestHashAlgorithm: "SHA-256";
  };
};

type SubmissionPackageResponse = {
  id: string;
  orgId: string;
  assessmentCycleId: string;
  scoreSnapshotId: string;
  readinessId: string;
  packageNumber: string;
  status: "CREATED" | "VOIDED";
  manifestJson: Record<string, unknown>;
  manifestHash: string;
  createdByUserId: string;
  createdAt: Date;
  voidedByUserId: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  updatedAt: Date;
};

type ServiceOptions = {
  repository: SubmissionPackageRepository;
  now?: () => Date;
};

type PgError = Error & {
  code?: string;
  constraint?: string;
};

const MAX_PACKAGE_NUMBER_ATTEMPTS = 5;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    return Object.keys(input)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize(input[key]);
        return acc;
      }, {});
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function manifestHashFor(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export class SubmissionPackageService {
  private readonly repository: SubmissionPackageRepository;
  private readonly now: () => Date;

  public constructor(options: ServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
  }

  public async createPackage(
    tx: PoolClient,
    claims: AuthClaims,
    cycleId: string,
    requestMeta: AuthRequestMeta,
  ): Promise<SubmissionPackageResponse> {
    const actor = await this.resolveActor(tx, claims);
    if (actor.role !== "admin") {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const cycle = await this.repository.getCycleForPackageUpdate(
      tx,
      claims.orgId,
      cycleId,
    );
    if (!cycle) {
      throw AUTH_ERRORS.ASSESSMENT_CYCLE_NOT_FOUND();
    }
    if (cycle.status !== "READY_FOR_SUBMISSION") {
      throw AUTH_ERRORS.SUBMISSION_PACKAGE_REQUIRES_READY_FOR_SUBMISSION();
    }
    await assertCorrectionExecutionActiveForCycle(tx, cycle);

    const readiness = await this.repository.getReadinessForCycle(
      tx,
      claims.orgId,
      cycle.id,
    );
    if (!readiness) {
      throw AUTH_ERRORS.SUBMISSION_READINESS_NOT_FOUND();
    }

    const score = await this.repository.getScoreSnapshotForCycle(
      tx,
      claims.orgId,
      cycle.id,
    );
    if (!score) {
      throw AUTH_ERRORS.ASSESSMENT_SCORE_REQUIRED();
    }
    this.assertFreshScore(score, cycle.finalized_internal_at);

    const existing = await this.repository.getActivePackageByCycle(
      claims.orgId,
      cycle.id,
      tx,
    );
    if (existing) {
      throw AUTH_ERRORS.SUBMISSION_PACKAGE_ALREADY_EXISTS();
    }

    const now = this.now();
    const counts = await this.repository.getManifestCounts(tx, cycle.id);
    const manifest = this.buildManifest({
      claims,
      cycleId: cycle.id,
      readinessId: readiness.id,
      score,
      counts,
      createdAt: now,
    });
    const manifestHash = manifestHashFor(manifest);

    const created = await this.insertPackageWithRetry(tx, {
      claims,
      cycleId: cycle.id,
      readinessId: readiness.id,
      scoreSnapshotId: score.id,
      manifest,
      manifestHash,
      createdAt: now,
    });

    await this.repository.appendAuditEvent(tx, {
      eventType: "SUBMISSION_PACKAGE_CREATED",
      severity: "INFO",
      userId: claims.userId,
      orgId: claims.orgId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: {
        category: "submission_package_created",
        org_id: claims.orgId,
        assessment_cycle_id: cycle.id,
        submission_package_id: created.id,
        package_number: created.package_number,
        manifest_hash: created.manifest_hash,
        score_snapshot_id: score.id,
        actor_user_id: claims.userId,
        actor_org_id: claims.orgId,
        timestamp: now.toISOString(),
        request_ip: requestMeta.ipAddress,
        user_agent: requestMeta.userAgent,
      },
    });

    return this.toResponse(created);
  }

  public async getActivePackageByCycle(
    tx: PoolClient,
    claims: AuthClaims,
    cycleId: string,
  ): Promise<SubmissionPackageResponse> {
    await this.resolveActor(tx, claims);
    const record = await this.repository.getActivePackageByCycle(
      claims.orgId,
      cycleId,
      tx,
    );
    if (!record) {
      throw AUTH_ERRORS.SUBMISSION_PACKAGE_NOT_FOUND();
    }
    return this.toResponse(record);
  }

  public async getPackageById(
    tx: PoolClient,
    claims: AuthClaims,
    packageId: string,
  ): Promise<SubmissionPackageResponse> {
    await this.resolveActor(tx, claims);
    const record = await this.repository.getPackageById(claims.orgId, packageId, tx);
    if (!record) {
      throw AUTH_ERRORS.SUBMISSION_PACKAGE_NOT_FOUND();
    }
    return this.toResponse(record);
  }

  public async voidPackage(
    tx: PoolClient,
    claims: AuthClaims,
    packageId: string,
    reasonInput: unknown,
    requestMeta: AuthRequestMeta,
  ): Promise<SubmissionPackageResponse> {
    const actor = await this.resolveActor(tx, claims);
    if (actor.role !== "admin") {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const existing = await this.repository.getPackageForUpdate(
      tx,
      claims.orgId,
      packageId,
    );
    if (!existing) {
      throw AUTH_ERRORS.SUBMISSION_PACKAGE_NOT_FOUND();
    }
    if (existing.status !== "CREATED") {
      throw AUTH_ERRORS.CONFLICT();
    }
    if (
      await this.repository.hasActiveExternalSubmission(
        tx,
        claims.orgId,
        existing.id,
      )
    ) {
      throw AUTH_ERRORS.PACKAGE_HAS_ACTIVE_SUBMISSION();
    }

    const reason = this.normalizeVoidReason(reasonInput);
    const now = this.now();
    const voided = await this.repository.voidPackage(tx, {
      orgId: claims.orgId,
      packageId: existing.id,
      voidedByUserId: claims.userId,
      voidedAt: now,
      voidReason: reason,
    });
    if (!voided) {
      throw AUTH_ERRORS.CONFLICT();
    }

    await this.repository.appendAuditEvent(tx, {
      eventType: "SUBMISSION_PACKAGE_VOIDED",
      severity: "INFO",
      userId: claims.userId,
      orgId: claims.orgId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: {
        category: "submission_package_voided",
        org_id: claims.orgId,
        assessment_cycle_id: existing.assessment_cycle_id,
        submission_package_id: existing.id,
        package_number: existing.package_number,
        reason,
        actor_user_id: claims.userId,
        actor_org_id: claims.orgId,
        timestamp: now.toISOString(),
        request_ip: requestMeta.ipAddress,
        user_agent: requestMeta.userAgent,
      },
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

  private assertFreshScore(
    score: ScoreSnapshotForPackage,
    finalizedInternalAt: Date | null,
  ): void {
    if (!score.calculated_at || !finalizedInternalAt) {
      throw AUTH_ERRORS.ASSESSMENT_SCORE_STALE();
    }
    if (score.calculated_at.getTime() < finalizedInternalAt.getTime()) {
      throw AUTH_ERRORS.ASSESSMENT_SCORE_STALE();
    }
  }

  private buildManifest(input: {
    claims: AuthClaims;
    cycleId: string;
    readinessId: string;
    score: ScoreSnapshotForPackage;
    counts: PackageManifestCounts;
    createdAt: Date;
  }): PackageManifest {
    return {
      packageVersion: "SUBMISSION_PACKAGE_V1",
      orgId: input.claims.orgId,
      assessmentCycleId: input.cycleId,
      scoreSnapshotId: input.score.id,
      readinessId: input.readinessId,
      createdAt: input.createdAt.toISOString(),
      createdByUserId: input.claims.userId,
      assessmentStatus: "READY_FOR_SUBMISSION",
      scoringVersion: input.score.scoring_version,
      overallScore:
        input.score.overall_score === null ? null : Number(input.score.overall_score),
      overallLabel: input.score.overall_label,
      counts: {
        totalRequirements: input.score.total_requirements,
        applicableRequirements: input.score.applicable_requirements,
        notApplicableRequirements: input.score.not_applicable_requirements,
        evidenceFiles: input.counts.evidence_files,
        checklists: input.counts.checklists,
      },
      hashes: {
        manifestHashAlgorithm: "SHA-256",
      },
    };
  }

  private async insertPackageWithRetry(
    tx: PoolClient,
    input: {
      claims: AuthClaims;
      cycleId: string;
      readinessId: string;
      scoreSnapshotId: string;
      manifest: PackageManifest;
      manifestHash: string;
      createdAt: Date;
    },
  ): Promise<SubmissionPackageRecord> {
    for (let attempt = 0; attempt < MAX_PACKAGE_NUMBER_ATTEMPTS; attempt += 1) {
      try {
        return await this.repository.insertPackage(tx, {
          orgId: input.claims.orgId,
          assessmentCycleId: input.cycleId,
          scoreSnapshotId: input.scoreSnapshotId,
          readinessId: input.readinessId,
          packageNumber: this.generatePackageNumber(input.createdAt),
          manifestJson: input.manifest,
          manifestHash: input.manifestHash,
          createdByUserId: input.claims.userId,
          createdAt: input.createdAt,
        });
      } catch (err) {
        const pgErr = err as PgError;
        if (pgErr.code !== "23505") {
          throw err;
        }
        const active = await this.repository.getActivePackageByCycle(
          input.claims.orgId,
          input.cycleId,
          tx,
        );
        if (active || pgErr.constraint === "uq_submission_packages_one_created_per_cycle") {
          throw AUTH_ERRORS.SUBMISSION_PACKAGE_ALREADY_EXISTS();
        }
      }
    }
    throw AUTH_ERRORS.CONFLICT();
  }

  private generatePackageNumber(now: Date): string {
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    return `SUB-${yyyy}${mm}${dd}-${randomBytes(4).toString("hex").toUpperCase()}`;
  }

  private normalizeVoidReason(value: unknown): string {
    if (typeof value !== "string") {
      throw AUTH_ERRORS.INVALID_SUBMISSION_PACKAGE_VOID_REASON();
    }
    const trimmed = value.trim();
    if (trimmed.length < 10 || trimmed.length > 2000) {
      throw AUTH_ERRORS.INVALID_SUBMISSION_PACKAGE_VOID_REASON();
    }
    return trimmed;
  }

  private toResponse(record: SubmissionPackageRecord): SubmissionPackageResponse {
    return {
      id: record.id,
      orgId: record.org_id,
      assessmentCycleId: record.assessment_cycle_id,
      scoreSnapshotId: record.score_snapshot_id,
      readinessId: record.readiness_id,
      packageNumber: record.package_number,
      status: record.status,
      manifestJson: record.manifest_json,
      manifestHash: record.manifest_hash,
      createdByUserId: record.created_by_user_id,
      createdAt: record.created_at,
      voidedByUserId: record.voided_by_user_id,
      voidedAt: record.voided_at,
      voidReason: record.void_reason,
      updatedAt: record.updated_at,
    };
  }
}

export type { PackageManifest, SubmissionPackageResponse };
