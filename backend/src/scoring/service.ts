import type { PoolClient } from "pg";

import { AUTH_ERRORS } from "../auth/errors.js";
import type { AuthClaims, AuthRequestMeta } from "../auth/types.js";
import { assertCorrectionExecutionActiveForCycle } from "../correction-execution/guard.js";
import {
  ScoringRepository,
  type AssessmentItemStatus,
  type ControlScoreInput,
  type ControlScoreRecord,
  type EvidenceQuality,
  type RequirementScoreInput,
  type RequirementScoreRecord,
  type ScoreLabel,
  type ScoreSnapshotRecord,
} from "./repository.js";

type PaginationInput = {
  page?: number;
  pageSize?: number;
};

type PaginatedResponse<T> = {
  page: number;
  pageSize: number;
  total: number;
  items: T[];
};

type ScoreSnapshotResponse = {
  id: string;
  assessmentCycleId: string;
  orgId: string;
  scoringVersion: string;
  overallScore: string | null;
  overallLabel: ScoreLabel | null;
  totalRequirements: number;
  applicableRequirements: number;
  notApplicableRequirements: number;
  notCompliantCount: number;
  partiallyCompliantCount: number;
  mostlyCompliantCount: number;
  fullyCompliantCount: number;
  calculatedByUserId: string | null;
  calculatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type RequirementScoreResponse = {
  id: string;
  scoreSnapshotId: string;
  assessmentRequirementItemId: string;
  pisfRequirementId: string;
  assessmentStatus: Exclude<AssessmentItemStatus, "UNASSESSED">;
  evidenceQuality: EvidenceQuality | null;
  statusScore: string | null;
  evidenceQualityCap: string | null;
  finalScore: string | null;
  excluded: boolean;
  exclusionReason: string | null;
  createdAt: Date;
};

type ControlScoreResponse = {
  id: string;
  scoreSnapshotId: string;
  pisfControlId: string;
  controlScore: string | null;
  applicableRequirements: number;
  excludedRequirements: number;
  totalRequirements: number;
  createdAt: Date;
};

type ServiceOptions = {
  repository: ScoringRepository;
  now?: () => Date;
};

type ControlAccumulator = {
  pisfControlId: string;
  totalRequirements: number;
  excludedRequirements: number;
  scores: number[];
};

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const STATUS_SCORES: Record<
  Exclude<AssessmentItemStatus, "UNASSESSED" | "NOT_APPLICABLE">,
  number
> = {
  NOT_COMPLIANT: 0,
  PARTIALLY_COMPLIANT: 40,
  MOSTLY_COMPLIANT: 70,
  FULLY_COMPLIANT: 100,
};

const EVIDENCE_CAPS: Record<EvidenceQuality, number> = {
  STRONG: 100,
  MODERATE: 80,
  WEAK: 50,
  NONE: 20,
};

export function scoreLabelFor(score: number | null): ScoreLabel | null {
  if (score === null) {
    return null;
  }
  if (score < 50) {
    return "NON_COMPLIANT";
  }
  if (score < 70) {
    return "PARTIALLY_COMPLIANT";
  }
  if (score < 90) {
    return "SUBSTANTIALLY_COMPLIANT";
  }
  return "COMPLIANT";
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

export class ScoringService {
  private readonly repository: ScoringRepository;
  private readonly now: () => Date;

  public constructor(options: ServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
  }

  public async calculateScore(
    tx: PoolClient,
    claims: AuthClaims,
    cycleId: string,
    requestMeta: AuthRequestMeta,
  ): Promise<ScoreSnapshotResponse> {
    const actor = await this.resolveActor(tx, claims);
    if (actor.role !== "admin") {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const cycle = await this.repository.getCycleForScoringUpdate(
      tx,
      claims.orgId,
      cycleId,
    );
    if (!cycle) {
      throw AUTH_ERRORS.ASSESSMENT_CYCLE_NOT_FOUND();
    }
    if (cycle.status !== "FINALIZED_INTERNAL") {
      throw AUTH_ERRORS.ASSESSMENT_SCORE_REQUIRES_FINALIZED_INTERNAL();
    }
    await assertCorrectionExecutionActiveForCycle(tx, cycle);

    const unassessedCount = await this.repository.countUnassessedItems(tx, cycle.id);
    if (unassessedCount > 0) {
      throw AUTH_ERRORS.ASSESSMENT_SCORE_BLOCKED_UNASSESSED();
    }

    const missingChecklistCount =
      await this.repository.countMissingRequiredChecklists(tx, cycle.id);
    if (missingChecklistCount > 0) {
      throw AUTH_ERRORS.ASSESSMENT_SCORE_BLOCKED_MISSING_EVIDENCE_CHECKLIST();
    }

    const sourceRows = await this.repository.listScoringSourceRows(tx, cycle.id);
    const snapshot = await this.repository.upsertScoreSnapshot(tx, claims.orgId, cycle.id);
    await this.repository.clearRequirementScores(tx, snapshot.id);
    await this.repository.clearControlScores(tx, snapshot.id);

    const requirementScores: RequirementScoreInput[] = [];
    const controlMap = new Map<string, ControlAccumulator>();
    const applicableScores: number[] = [];
    let notApplicableRequirements = 0;
    let notCompliantCount = 0;
    let partiallyCompliantCount = 0;
    let mostlyCompliantCount = 0;
    let fullyCompliantCount = 0;

    for (const row of sourceRows) {
      const control = controlMap.get(row.pisf_control_id) ?? {
        pisfControlId: row.pisf_control_id,
        totalRequirements: 0,
        excludedRequirements: 0,
        scores: [],
      };
      control.totalRequirements += 1;
      controlMap.set(row.pisf_control_id, control);

      if (row.assessment_status === "UNASSESSED") {
        throw AUTH_ERRORS.ASSESSMENT_SCORE_BLOCKED_UNASSESSED();
      }

      if (row.assessment_status === "NOT_APPLICABLE") {
        notApplicableRequirements += 1;
        control.excludedRequirements += 1;
        requirementScores.push({
          scoreSnapshotId: snapshot.id,
          assessmentRequirementItemId: row.assessment_requirement_item_id,
          pisfRequirementId: row.pisf_requirement_id,
          assessmentStatus: "NOT_APPLICABLE",
          evidenceQuality: null,
          statusScore: null,
          evidenceQualityCap: null,
          finalScore: null,
          excluded: true,
          exclusionReason: "NOT_APPLICABLE",
        });
        continue;
      }

      if (!row.evidence_quality) {
        throw AUTH_ERRORS.ASSESSMENT_SCORE_BLOCKED_MISSING_EVIDENCE_CHECKLIST();
      }

      const statusScore = STATUS_SCORES[row.assessment_status];
      const evidenceQualityCap = EVIDENCE_CAPS[row.evidence_quality];
      const finalScore = Math.min(statusScore, evidenceQualityCap);
      applicableScores.push(finalScore);
      control.scores.push(finalScore);

      if (row.assessment_status === "NOT_COMPLIANT") {
        notCompliantCount += 1;
      } else if (row.assessment_status === "PARTIALLY_COMPLIANT") {
        partiallyCompliantCount += 1;
      } else if (row.assessment_status === "MOSTLY_COMPLIANT") {
        mostlyCompliantCount += 1;
      } else if (row.assessment_status === "FULLY_COMPLIANT") {
        fullyCompliantCount += 1;
      }

      requirementScores.push({
        scoreSnapshotId: snapshot.id,
        assessmentRequirementItemId: row.assessment_requirement_item_id,
        pisfRequirementId: row.pisf_requirement_id,
        assessmentStatus: row.assessment_status,
        evidenceQuality: row.evidence_quality,
        statusScore,
        evidenceQualityCap,
        finalScore,
        excluded: false,
        exclusionReason: null,
      });
    }

    const controlScores: ControlScoreInput[] = [...controlMap.values()].map((control) => {
      const controlScore =
        control.scores.length === 0
          ? null
          : roundScore(
              control.scores.reduce((sum, score) => sum + score, 0) /
                control.scores.length,
            );
      return {
        scoreSnapshotId: snapshot.id,
        pisfControlId: control.pisfControlId,
        controlScore,
        applicableRequirements: control.scores.length,
        excludedRequirements: control.excludedRequirements,
        totalRequirements: control.totalRequirements,
      };
    });

    const overallScore =
      applicableScores.length === 0
        ? null
        : roundScore(
            applicableScores.reduce((sum, score) => sum + score, 0) /
              applicableScores.length,
          );
    const overallLabel = scoreLabelFor(overallScore);
    const calculatedAt = this.now();

    await this.repository.insertRequirementScores(tx, requirementScores);
    await this.repository.insertControlScores(tx, controlScores);
    const updatedSnapshot = await this.repository.updateSnapshotSummary(tx, {
      snapshotId: snapshot.id,
      overallScore,
      overallLabel,
      totalRequirements: sourceRows.length,
      applicableRequirements: applicableScores.length,
      notApplicableRequirements,
      notCompliantCount,
      partiallyCompliantCount,
      mostlyCompliantCount,
      fullyCompliantCount,
      calculatedByUserId: claims.userId,
      calculatedAt,
    });

    await this.repository.appendAuditEvent(tx, {
      eventType: "ASSESSMENT_SCORE_CALCULATED",
      severity: "INFO",
      userId: claims.userId,
      orgId: claims.orgId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: {
        category: "assessment_score_calculated",
        org_id: claims.orgId,
        assessment_cycle_id: cycle.id,
        score_snapshot_id: updatedSnapshot.id,
        overall_score: overallScore,
        overall_label: overallLabel,
        scoring_version: updatedSnapshot.scoring_version,
        actor_user_id: claims.userId,
        actor_org_id: claims.orgId,
        timestamp: calculatedAt.toISOString(),
        request_ip: requestMeta.ipAddress,
        user_agent: requestMeta.userAgent,
      },
    });

    return this.toSnapshotResponse(updatedSnapshot);
  }

  public async getScore(
    tx: PoolClient,
    claims: AuthClaims,
    cycleId: string,
  ): Promise<ScoreSnapshotResponse> {
    await this.resolveActor(tx, claims);
    const cycle = await this.repository.getCycleByOrg(claims.orgId, cycleId, tx);
    if (!cycle) {
      throw AUTH_ERRORS.ASSESSMENT_CYCLE_NOT_FOUND();
    }
    const snapshot = await this.repository.getScoreSnapshot(claims.orgId, cycleId, tx);
    if (!snapshot) {
      throw AUTH_ERRORS.ASSESSMENT_SCORE_NOT_FOUND();
    }
    return this.toSnapshotResponse(snapshot);
  }

  public async listRequirementScores(
    tx: PoolClient,
    claims: AuthClaims,
    cycleId: string,
    input: PaginationInput,
  ): Promise<PaginatedResponse<RequirementScoreResponse>> {
    const snapshot = await this.getScore(tx, claims, cycleId);
    const page = this.normalizePage(input.page);
    const pageSize = this.normalizePageSize(input.pageSize);
    const result = await this.repository.listRequirementScores(
      snapshot.id,
      pageSize,
      (page - 1) * pageSize,
      tx,
    );
    return {
      page,
      pageSize,
      total: result.total,
      items: result.items.map((item) => this.toRequirementScoreResponse(item)),
    };
  }

  public async listControlScores(
    tx: PoolClient,
    claims: AuthClaims,
    cycleId: string,
    input: PaginationInput,
  ): Promise<PaginatedResponse<ControlScoreResponse>> {
    const snapshot = await this.getScore(tx, claims, cycleId);
    const page = this.normalizePage(input.page);
    const pageSize = this.normalizePageSize(input.pageSize);
    const result = await this.repository.listControlScores(
      snapshot.id,
      pageSize,
      (page - 1) * pageSize,
      tx,
    );
    return {
      page,
      pageSize,
      total: result.total,
      items: result.items.map((item) => this.toControlScoreResponse(item)),
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

  private toSnapshotResponse(record: ScoreSnapshotRecord): ScoreSnapshotResponse {
    return {
      id: record.id,
      assessmentCycleId: record.assessment_cycle_id,
      orgId: record.org_id,
      scoringVersion: record.scoring_version,
      overallScore: record.overall_score,
      overallLabel: record.overall_label,
      totalRequirements: record.total_requirements,
      applicableRequirements: record.applicable_requirements,
      notApplicableRequirements: record.not_applicable_requirements,
      notCompliantCount: record.not_compliant_count,
      partiallyCompliantCount: record.partially_compliant_count,
      mostlyCompliantCount: record.mostly_compliant_count,
      fullyCompliantCount: record.fully_compliant_count,
      calculatedByUserId: record.calculated_by_user_id,
      calculatedAt: record.calculated_at,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }

  private toRequirementScoreResponse(
    record: RequirementScoreRecord,
  ): RequirementScoreResponse {
    return {
      id: record.id,
      scoreSnapshotId: record.score_snapshot_id,
      assessmentRequirementItemId: record.assessment_requirement_item_id,
      pisfRequirementId: record.pisf_requirement_id,
      assessmentStatus: record.assessment_status,
      evidenceQuality: record.evidence_quality,
      statusScore: record.status_score,
      evidenceQualityCap: record.evidence_quality_cap,
      finalScore: record.final_score,
      excluded: record.excluded,
      exclusionReason: record.exclusion_reason,
      createdAt: record.created_at,
    };
  }

  private toControlScoreResponse(record: ControlScoreRecord): ControlScoreResponse {
    return {
      id: record.id,
      scoreSnapshotId: record.score_snapshot_id,
      pisfControlId: record.pisf_control_id,
      controlScore: record.control_score,
      applicableRequirements: record.applicable_requirements,
      excludedRequirements: record.excluded_requirements,
      totalRequirements: record.total_requirements,
      createdAt: record.created_at,
    };
  }
}

export type {
  ControlScoreResponse,
  PaginationInput,
  RequirementScoreResponse,
  ScoreSnapshotResponse,
};
