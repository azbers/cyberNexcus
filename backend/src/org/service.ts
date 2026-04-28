import type { PoolClient } from "pg";

import { AUTH_ERRORS } from "../auth/errors.js";
import type { AuthClaims, AuthRequestMeta, OrgStatus } from "../auth/types.js";
import {
  OrganizationRepository,
  type OrganizationLifecycleAuditEventType,
  type PendingOrganizationItem,
} from "./repository.js";

type ListPendingInput = {
  page?: number;
  pageSize?: number;
};

type ListPendingResult = {
  page: number;
  pageSize: number;
  total: number;
  items: PendingOrganizationItem[];
};

type LifecycleAction = "approve" | "reject" | "suspend" | "reactivate";

type OrganizationLifecycleResult = {
  id: string;
  name: string;
  status: OrgStatus;
  created_at: Date;
};

type ServiceOptions = {
  repository: OrganizationRepository;
  now?: () => Date;
};

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MIN_REASON_LENGTH = 10;
const MAX_REASON_LENGTH = 2000;

export class OrganizationService {
  private readonly repository: OrganizationRepository;
  private readonly now: () => Date;

  public constructor(options: ServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
  }

  public async listPending(
    tx: PoolClient,
    claims: AuthClaims,
    input: ListPendingInput,
  ): Promise<ListPendingResult> {
    await this.assertAdmin(tx, claims);
    const page = this.normalizePage(input.page);
    const pageSize = this.normalizePageSize(input.pageSize);
    const offset = (page - 1) * pageSize;

    const pending = await this.repository.listPendingOrganizations(tx, {
      limit: pageSize,
      offset,
    });

    return {
      page,
      pageSize,
      total: pending.total,
      items: pending.items,
    };
  }

  public async approve(
    tx: PoolClient,
    claims: AuthClaims,
    orgId: string,
    reason: string,
    requestMeta: AuthRequestMeta,
  ): Promise<OrganizationLifecycleResult> {
    return this.applyLifecycleAction(tx, claims, orgId, reason, requestMeta, "approve");
  }

  public async reject(
    tx: PoolClient,
    claims: AuthClaims,
    orgId: string,
    reason: string,
    requestMeta: AuthRequestMeta,
  ): Promise<OrganizationLifecycleResult> {
    return this.applyLifecycleAction(tx, claims, orgId, reason, requestMeta, "reject");
  }

  public async suspend(
    tx: PoolClient,
    claims: AuthClaims,
    orgId: string,
    reason: string,
    requestMeta: AuthRequestMeta,
  ): Promise<OrganizationLifecycleResult> {
    return this.applyLifecycleAction(tx, claims, orgId, reason, requestMeta, "suspend");
  }

  public async reactivate(
    tx: PoolClient,
    claims: AuthClaims,
    orgId: string,
    reason: string,
    requestMeta: AuthRequestMeta,
  ): Promise<OrganizationLifecycleResult> {
    return this.applyLifecycleAction(tx, claims, orgId, reason, requestMeta, "reactivate");
  }

  private async applyLifecycleAction(
    tx: PoolClient,
    claims: AuthClaims,
    orgId: string,
    reason: string,
    requestMeta: AuthRequestMeta,
    action: LifecycleAction,
  ): Promise<OrganizationLifecycleResult> {
    const actor = await this.assertAdmin(tx, claims);
    const normalizedReason = this.normalizeReason(reason);
    const organization = await this.repository.getOrganizationForUpdate(tx, orgId);
    if (!organization) {
      throw AUTH_ERRORS.ORG_NOT_FOUND();
    }

    const oldStatus = organization.status;
    const now = this.now();

    let newStatus: OrgStatus;
    let rejectionReason: string | null;
    let suspendedAt: Date | null;
    let deactivatedAt: Date | null;
    let eventType: OrganizationLifecycleAuditEventType;

    if (action === "approve" && oldStatus === "PENDING") {
      newStatus = "APPROVED";
      rejectionReason = null;
      suspendedAt = null;
      deactivatedAt = null;
      eventType = "ORG_APPROVED";
    } else if (action === "reject" && oldStatus === "PENDING") {
      newStatus = "REJECTED";
      rejectionReason = normalizedReason;
      suspendedAt = null;
      deactivatedAt = now;
      eventType = "ORG_REJECTED";
    } else if (action === "suspend" && oldStatus === "APPROVED") {
      newStatus = "SUSPENDED";
      rejectionReason = null;
      suspendedAt = now;
      deactivatedAt = now;
      eventType = "ORG_SUSPENDED";
    } else if (action === "reactivate" && oldStatus === "SUSPENDED") {
      newStatus = "APPROVED";
      rejectionReason = null;
      suspendedAt = null;
      deactivatedAt = null;
      eventType = "ORG_REACTIVATED";
    } else {
      throw AUTH_ERRORS.CONFLICT();
    }

    const updated = await this.repository.updateOrganizationLifecycle(tx, {
      orgId: organization.id,
      status: newStatus,
      rejectionReason,
      suspendedAt,
      deactivatedAt,
    });

    await this.repository.appendAuditEvent(tx, {
      eventType,
      severity: action === "reject" || action === "suspend" ? "WARNING" : "INFO",
      userId: claims.userId,
      orgId: claims.orgId,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      metadata: {
        old_status: oldStatus,
        new_status: newStatus,
        reason: normalizedReason,
        actor_user_id: claims.userId,
        actor_org_id: actor.org_id,
        target_org_id: organization.id,
        timestamp: now.toISOString(),
        request_ip: requestMeta.ipAddress,
        user_agent: requestMeta.userAgent,
      },
    });

    return {
      id: updated.id,
      name: updated.name,
      status: updated.status,
      created_at: updated.created_at,
    };
  }

  private async assertAdmin(tx: PoolClient, claims: AuthClaims): Promise<{ org_id: string }> {
    const actor = await this.repository.findActorProfile(tx, claims.userId);
    if (!actor || actor.role !== "admin" || actor.org_id !== claims.orgId) {
      throw AUTH_ERRORS.FORBIDDEN_ACTION();
    }
    return { org_id: actor.org_id };
  }

  private normalizeReason(reason: string): string {
    const normalized = reason.trim();
    if (
      normalized.length < MIN_REASON_LENGTH ||
      normalized.length > MAX_REASON_LENGTH
    ) {
      throw AUTH_ERRORS.INVALID_REASON();
    }
    return normalized;
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
}

export type { ListPendingResult, OrganizationLifecycleResult };
