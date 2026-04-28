import type { PoolClient } from "pg";

import { AUTH_ERRORS } from "../auth/errors.js";
import type { AuthClaims, AuthRequestMeta } from "../auth/types.js";
import { assertCorrectionExecutionActiveForCycle } from "../correction-execution/guard.js";
import {
  AssessmentRepository,
  type AssessmentCycleRecord,
  type AssessmentCycleStatus,
  type AssessmentEvidenceChecklistRecord,
  type AssessmentItemRecord,
  type AssessmentItemStatus,
  type ChecklistAddressAnswer,
  type ChecklistApprovalAnswer,
  type ChecklistYesNo,
  type ChecklistYesNoNa,
  type EvidenceQuality,
} from "./repository.js";

type AssessmentPaginationInput = {
  page?: number;
  pageSize?: number;
};

type ListCyclesInput = AssessmentPaginationInput & {
  status?: string;
};

type ListItemsInput = AssessmentPaginationInput & {
  status?: string;
};

type PaginatedResponse<T> = {
  page: number;
  pageSize: number;
  total: number;
  items: T[];
};

type CreateDraftResult = {
  cycle: AssessmentCycleRecord;
  seededItemCount: number;
};

type EvidenceChecklistInput = {
  datedWithin12Months?: unknown;
  organizationSpecific?: unknown;
  addressesRequirement?: unknown;
  approvedByAuthority?: unknown;
  currentlyInForce?: unknown;
  evidenceQuality?: unknown;
  reviewNotes?: unknown;
};

type EvidenceChecklistResponse = {
  id: string;
  orgId: string;
  assessmentCycleId: string;
  assessmentRequirementItemId: string;
  datedWithin12Months: ChecklistYesNoNa;
  organizationSpecific: ChecklistYesNo;
  addressesRequirement: ChecklistAddressAnswer;
  approvedByAuthority: ChecklistApprovalAnswer;
  currentlyInForce: ChecklistYesNoNa;
  evidenceQuality: EvidenceQuality;
  reviewNotes: string | null;
  reviewedByUserId: string;
  reviewedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type ServiceOptions = {
  repository: AssessmentRepository;
  now?: () => Date;
};

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const CYCLE_STATUSES: AssessmentCycleStatus[] = [
  "DRAFT",
  "FINALIZED_INTERNAL",
  "READY_FOR_SUBMISSION",
];
const ITEM_STATUSES: AssessmentItemStatus[] = [
  "UNASSESSED",
  "NOT_COMPLIANT",
  "PARTIALLY_COMPLIANT",
  "MOSTLY_COMPLIANT",
  "FULLY_COMPLIANT",
  "NOT_APPLICABLE",
];

const YES_NO_NA: ChecklistYesNoNa[] = ["YES", "NO", "NOT_APPLICABLE"];
const YES_NO: ChecklistYesNo[] = ["YES", "NO"];
const ADDRESS_ANSWERS: ChecklistAddressAnswer[] = ["YES", "PARTIALLY", "NO"];
const APPROVAL_ANSWERS: ChecklistApprovalAnswer[] = [
  "YES",
  "PENDING",
  "NO",
  "NOT_APPLICABLE",
];
const EVIDENCE_QUALITIES: EvidenceQuality[] = ["STRONG", "MODERATE", "WEAK", "NONE"];
const UPDATE_ALLOWED_ROLES = new Set(["admin", "responsible_officer", "it_security_lead"]);

function normalizeCycleStatus(value?: string): AssessmentCycleStatus | null {
  if (!value) {
    return null;
  }
  const upper = value.toUpperCase();
  return CYCLE_STATUSES.includes(upper as AssessmentCycleStatus)
    ? (upper as AssessmentCycleStatus)
    : null;
}

export class AssessmentService {
  private readonly repository: AssessmentRepository;
  private readonly now: () => Date;

  public constructor(options: ServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
  }

  public async listCycles(
    tx: PoolClient,
    claims: AuthClaims,
    input: ListCyclesInput,
  ): Promise<PaginatedResponse<AssessmentCycleRecord>> {
    await this.resolveActor(tx, claims);
    const page = this.normalizePage(input.page);
    const pageSize = this.normalizePageSize(input.pageSize);
    const result = await this.repository.listCycles(
      claims.orgId,
      {
        status: normalizeCycleStatus(input.status),
        limit: pageSize,
        offset: (page - 1) * pageSize,
      },
      tx,
    );
    return { page, pageSize, total: result.total, items: result.items };
  }

  public async getCycleById(
    tx: PoolClient,
    claims: AuthClaims,
    cycleId: string,
  ): Promise<AssessmentCycleRecord> {
    await this.resolveActor(tx, claims);
    const cycle = await this.repository.getCycleById(claims.orgId, cycleId, tx);
    if (!cycle) {
      throw AUTH_ERRORS.ASSESSMENT_CYCLE_NOT_FOUND();
    }
    return cycle;
  }

  public async listCycleItems(
    tx: PoolClient,
    claims: AuthClaims,
    cycleId: string,
    input: ListItemsInput,
  ): Promise<PaginatedResponse<AssessmentItemRecord>> {
    await this.resolveActor(tx, claims);
    const cycle = await this.repository.getCycleById(claims.orgId, cycleId, tx);
    if (!cycle) {
      throw AUTH_ERRORS.ASSESSMENT_CYCLE_NOT_FOUND();
    }

    const page = this.normalizePage(input.page);
    const pageSize = this.normalizePageSize(input.pageSize);
    const status = this.normalizeItemStatus(input.status);
    const result = await this.repository.listCycleItems(
      claims.orgId,
      cycleId,
      {
        status,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      },
      tx,
    );
    return { page, pageSize, total: result.total, items: result.items };
  }

  public async createDraftCycle(
    tx: PoolClient,
    claims: AuthClaims,
    requestMeta: AuthRequestMeta,
  ): Promise<CreateDraftResult> {
    const actor = await this.resolveActor(tx, claims);
    if (actor.role !== "admin") {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const existingDraft = await this.repository.findDraftCycleForOrg(tx, claims.orgId);
    if (existingDraft) {
      throw AUTH_ERRORS.ASSESSMENT_ALREADY_HAS_DRAFT();
    }

    const created = await this.repository.createDraftCycle(tx, {
      orgId: claims.orgId,
      createdByUserId: claims.userId,
    });
    const seededItemCount = await this.repository.seedItemsFromActiveRequirements(
      tx,
      created.id,
    );

    const now = this.now();
    await this.repository.appendAuditEvent(tx, {
      eventType: "ASSESSMENT_DRAFT_CREATED",
      severity: "INFO",
      userId: claims.userId,
      orgId: claims.orgId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: {
        category: "assessment_draft_created",
        assessment_cycle_id: created.id,
        seeded_item_count: seededItemCount,
        actor_user_id: claims.userId,
        actor_org_id: claims.orgId,
        timestamp: now.toISOString(),
        request_ip: requestMeta.ipAddress,
        user_agent: requestMeta.userAgent,
      },
    });

    return { cycle: created, seededItemCount };
  }

  public async updateRequirementItemStatus(
    tx: PoolClient,
    claims: AuthClaims,
    cycleId: string,
    itemId: string,
    assessmentStatus: string,
    requestMeta: AuthRequestMeta,
  ): Promise<AssessmentItemRecord> {
    const actor = await this.resolveActor(tx, claims);
    if (!UPDATE_ALLOWED_ROLES.has(actor.role)) {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const cycle = await this.repository.getCycleForUpdate(tx, claims.orgId, cycleId);
    if (!cycle) {
      throw AUTH_ERRORS.ASSESSMENT_CYCLE_NOT_FOUND();
    }
    if (cycle.status !== "DRAFT") {
      throw AUTH_ERRORS.ASSESSMENT_CYCLE_FINALIZED();
    }
    await assertCorrectionExecutionActiveForCycle(tx, cycle);

    const existingItem = await this.repository.getItemForUpdate(tx, cycle.id, itemId);
    if (!existingItem) {
      throw AUTH_ERRORS.ASSESSMENT_ITEM_NOT_FOUND();
    }
    const normalizedStatus = this.normalizeItemStatus(assessmentStatus);
    if (!normalizedStatus) {
      throw AUTH_ERRORS.INVALID_ASSESSMENT_STATUS();
    }

    const updated = await this.repository.updateItemStatus(tx, {
      itemId: existingItem.id,
      status: normalizedStatus,
      updatedByUserId: claims.userId,
    });

    const now = this.now();
    await this.repository.appendAuditEvent(tx, {
      eventType: "ASSESSMENT_ITEM_STATUS_UPDATED",
      severity: "INFO",
      userId: claims.userId,
      orgId: claims.orgId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: {
        category: "assessment_item_status_updated",
        assessment_cycle_id: cycle.id,
        assessment_item_id: existingItem.id,
        target_requirement_id: existingItem.pisf_requirement_id,
        old_status: existingItem.assessment_status,
        new_status: updated.assessment_status,
        actor_user_id: claims.userId,
        actor_org_id: claims.orgId,
        timestamp: now.toISOString(),
        request_ip: requestMeta.ipAddress,
        user_agent: requestMeta.userAgent,
      },
    });

    return updated;
  }

  public async finalizeInternalCycle(
    tx: PoolClient,
    claims: AuthClaims,
    cycleId: string,
    requestMeta: AuthRequestMeta,
  ): Promise<AssessmentCycleRecord> {
    const actor = await this.resolveActor(tx, claims);
    if (actor.role !== "admin") {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const cycle = await this.repository.getCycleForUpdate(tx, claims.orgId, cycleId);
    if (!cycle) {
      throw AUTH_ERRORS.ASSESSMENT_CYCLE_NOT_FOUND();
    }
    if (cycle.status !== "DRAFT") {
      throw AUTH_ERRORS.ASSESSMENT_CYCLE_FINALIZED();
    }
    await assertCorrectionExecutionActiveForCycle(tx, cycle);

    const unresolvedCount = await this.repository.countUnassessedItems(tx, cycle.id);
    if (unresolvedCount > 0) {
      throw AUTH_ERRORS.ASSESSMENT_FINALIZE_BLOCKED_UNASSESSED();
    }

    const missingChecklistCount =
      await this.repository.countItemsMissingRequiredEvidenceChecklist(tx, cycle.id);
    if (missingChecklistCount > 0) {
      throw AUTH_ERRORS.ASSESSMENT_FINALIZE_BLOCKED_MISSING_EVIDENCE_CHECKLIST();
    }

    const now = this.now();
    const finalized = await this.repository.finalizeInternalCycle(
      tx,
      cycle.id,
      claims.userId,
      now,
    );
    if (!finalized) {
      throw AUTH_ERRORS.CONFLICT();
    }

    await this.repository.appendAuditEvent(tx, {
      eventType: "ASSESSMENT_INTERNAL_FINALIZED",
      severity: "INFO",
      userId: claims.userId,
      orgId: claims.orgId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: {
        category: "assessment_internal_finalized",
        assessment_cycle_id: cycle.id,
        actor_user_id: claims.userId,
        actor_org_id: claims.orgId,
        timestamp: now.toISOString(),
        request_ip: requestMeta.ipAddress,
        user_agent: requestMeta.userAgent,
      },
    });

    return finalized;
  }

  public async getEvidenceChecklist(
    tx: PoolClient,
    claims: AuthClaims,
    cycleId: string,
    itemId: string,
  ): Promise<EvidenceChecklistResponse> {
    await this.resolveActor(tx, claims);
    const checklist = await this.repository.getEvidenceChecklistByItem(
      claims.orgId,
      cycleId,
      itemId,
      tx,
    );
    if (!checklist) {
      throw AUTH_ERRORS.EVIDENCE_CHECKLIST_NOT_FOUND();
    }
    return this.toEvidenceChecklistResponse(checklist);
  }

  public async upsertEvidenceChecklist(
    tx: PoolClient,
    claims: AuthClaims,
    cycleId: string,
    itemId: string,
    input: EvidenceChecklistInput,
    requestMeta: AuthRequestMeta,
  ): Promise<EvidenceChecklistResponse> {
    const actor = await this.resolveActor(tx, claims);
    if (!UPDATE_ALLOWED_ROLES.has(actor.role)) {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }

    const cycle = await this.repository.getCycleForUpdate(tx, claims.orgId, cycleId);
    if (!cycle) {
      throw AUTH_ERRORS.ASSESSMENT_CYCLE_NOT_FOUND();
    }
    if (cycle.status !== "DRAFT") {
      throw AUTH_ERRORS.ASSESSMENT_CYCLE_FINALIZED();
    }
    await assertCorrectionExecutionActiveForCycle(tx, cycle);

    const item = await this.repository.getItemForUpdate(tx, cycle.id, itemId);
    if (!item) {
      throw AUTH_ERRORS.ASSESSMENT_ITEM_NOT_FOUND();
    }

    const normalized = this.normalizeEvidenceChecklistInput(input);
    const now = this.now();
    const checklist = await this.repository.upsertEvidenceChecklist(tx, {
      orgId: claims.orgId,
      assessmentCycleId: cycle.id,
      assessmentRequirementItemId: item.id,
      datedWithin12Months: normalized.datedWithin12Months,
      organizationSpecific: normalized.organizationSpecific,
      addressesRequirement: normalized.addressesRequirement,
      approvedByAuthority: normalized.approvedByAuthority,
      currentlyInForce: normalized.currentlyInForce,
      evidenceQuality: normalized.evidenceQuality,
      reviewNotes: normalized.reviewNotes,
      reviewedByUserId: claims.userId,
      reviewedAt: now,
    });

    await this.repository.appendAuditEvent(tx, {
      eventType: "EVIDENCE_CHECKLIST_UPSERTED",
      severity: "INFO",
      userId: claims.userId,
      orgId: claims.orgId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: {
        category: "evidence_checklist_upserted",
        org_id: claims.orgId,
        assessment_cycle_id: cycle.id,
        assessment_requirement_item_id: item.id,
        evidence_quality: checklist.evidence_quality,
        actor_user_id: claims.userId,
        actor_org_id: claims.orgId,
        timestamp: now.toISOString(),
        request_ip: requestMeta.ipAddress,
        user_agent: requestMeta.userAgent,
      },
    });

    return this.toEvidenceChecklistResponse(checklist);
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

  private normalizeItemStatus(value?: string): AssessmentItemStatus | null {
    if (!value) {
      return null;
    }
    const upper = value.toUpperCase();
    return ITEM_STATUSES.includes(upper as AssessmentItemStatus)
      ? (upper as AssessmentItemStatus)
      : null;
  }

  private normalizeEvidenceChecklistInput(
    input: EvidenceChecklistInput,
  ): {
    datedWithin12Months: ChecklistYesNoNa;
    organizationSpecific: ChecklistYesNo;
    addressesRequirement: ChecklistAddressAnswer;
    approvedByAuthority: ChecklistApprovalAnswer;
    currentlyInForce: ChecklistYesNoNa;
    evidenceQuality: EvidenceQuality;
    reviewNotes: string | null;
  } {
    const datedWithin12Months = this.requiredEnum(
      input.datedWithin12Months,
      YES_NO_NA,
    );
    const organizationSpecific = this.requiredEnum(
      input.organizationSpecific,
      YES_NO,
    );
    const addressesRequirement = this.requiredEnum(
      input.addressesRequirement,
      ADDRESS_ANSWERS,
    );
    const approvedByAuthority = this.requiredEnum(
      input.approvedByAuthority,
      APPROVAL_ANSWERS,
    );
    const currentlyInForce = this.requiredEnum(input.currentlyInForce, YES_NO_NA);
    const evidenceQuality = this.requiredEnum(
      input.evidenceQuality,
      EVIDENCE_QUALITIES,
    );
    const reviewNotes = this.normalizeReviewNotes(input.reviewNotes);

    return {
      datedWithin12Months,
      organizationSpecific,
      addressesRequirement,
      approvedByAuthority,
      currentlyInForce,
      evidenceQuality,
      reviewNotes,
    };
  }

  private requiredEnum<T extends string>(value: unknown, allowed: readonly T[]): T {
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      throw AUTH_ERRORS.INVALID_EVIDENCE_CHECKLIST();
    }
    return value as T;
  }

  private normalizeReviewNotes(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== "string" || value.length > 2000) {
      throw AUTH_ERRORS.INVALID_EVIDENCE_CHECKLIST();
    }
    return value;
  }

  private toEvidenceChecklistResponse(
    record: AssessmentEvidenceChecklistRecord,
  ): EvidenceChecklistResponse {
    return {
      id: record.id,
      orgId: record.org_id,
      assessmentCycleId: record.assessment_cycle_id,
      assessmentRequirementItemId: record.assessment_requirement_item_id,
      datedWithin12Months: record.dated_within_12_months,
      organizationSpecific: record.organization_specific,
      addressesRequirement: record.addresses_requirement,
      approvedByAuthority: record.approved_by_authority,
      currentlyInForce: record.currently_in_force,
      evidenceQuality: record.evidence_quality,
      reviewNotes: record.review_notes,
      reviewedByUserId: record.reviewed_by_user_id,
      reviewedAt: record.reviewed_at,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }
}

export type {
  AssessmentCycleStatus,
  AssessmentItemStatus,
  CreateDraftResult,
  EvidenceChecklistInput,
  EvidenceChecklistResponse,
  ListCyclesInput,
  ListItemsInput,
};
