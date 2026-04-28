import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { AUTH_ERRORS } from "../auth/errors.js";
import type { AuthClaims } from "../auth/types.js";
import {
  PisfRepository,
  type DerivationMethod,
  type RequirementStatus,
  type UpsertOutcome,
} from "./repository.js";

type SourceControlRow = {
  domain?: unknown;
  controlCode?: unknown;
  phase?: unknown;
  area?: unknown;
  subArea?: unknown;
  title?: unknown;
  shortSummary?: unknown;
  statement?: unknown;
  [key: string]: unknown;
};

type ImportSummary = {
  created: number;
  updated: number;
  unchanged: number;
  deactivated: number;
  reactivated: number;
  needs_review: number;
  errors: number;
};

type ImportResult = {
  batchId: string;
  status: "COMPLETED" | "SKIPPED";
  summary: ImportSummary;
};

type ImportInput = {
  sourceFileName: string;
  sourceChecksum: string;
  force: boolean;
  rows: SourceControlRow[];
};

type PaginationInput = {
  page?: number;
  pageSize?: number;
};

type ControlListInput = PaginationInput & {
  domainId?: string;
  phase?: string;
  search?: string;
};

type RequirementListInput = PaginationInput & {
  domainId?: string;
  controlId?: string;
  status?: string;
};

type PaginatedResponse<T> = {
  page: number;
  pageSize: number;
  total: number;
  items: T[];
};

type DerivedRequirement = {
  ordinal: number;
  requirementText: string;
  sourceFragment: string | null;
  derivationMethod: DerivationMethod;
  status: RequirementStatus;
};

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function toDomainCode(domain: string): string {
  const trimmed = domain.trim();
  const numberedMatch = trimmed.match(/^domain\s*([0-9]+)$/i);
  if (numberedMatch) {
    return `domain_${numberedMatch[1]}`;
  }
  return trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(([key, inner]) => `${JSON.stringify(key)}:${stableStringify(inner)}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(stableStringify(value), "utf8")
    .digest("hex");
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function incrementSummary(summary: ImportSummary, outcome: UpsertOutcome): void {
  if (outcome === "created") {
    summary.created += 1;
    return;
  }
  if (outcome === "updated") {
    summary.updated += 1;
    return;
  }
  if (outcome === "unchanged") {
    summary.unchanged += 1;
    return;
  }
  summary.reactivated += 1;
}

function deriveRequirements(statementRaw: string): DerivedRequirement[] {
  const sourceText = statementRaw.replace(/\r\n/g, "\n");
  const trimmed = sourceText.trim();
  const rawLines = sourceText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const allNumberedLines =
    rawLines.length > 1 &&
    rawLines.every((line) => /^\d+[\.\)]\s+/.test(line));

  if (allNumberedLines) {
    return rawLines.map((line, idx) => {
      const withoutPrefix = line.replace(/^\d+[\.\)]\s+/, "").trim();
      return {
        ordinal: idx + 1,
        requirementText: withoutPrefix.length > 0 ? withoutPrefix : line,
        sourceFragment: line,
        derivationMethod: "deterministic_split",
        status: "ACTIVE",
      };
    });
  }

  const multiLineAmbiguous = rawLines.length > 1 && !allNumberedLines;
  const singleLineAmbiguous =
    rawLines.length === 1 && /\b1[\.\)]\s+.+\b2[\.\)]\s+/.test(rawLines[0]);

  if (multiLineAmbiguous || singleLineAmbiguous) {
    return [
      {
        ordinal: 1,
        requirementText: trimmed,
        sourceFragment: null,
        derivationMethod: "manual_review_required",
        status: "NEEDS_REVIEW",
      },
    ];
  }

  return [
    {
      ordinal: 1,
      requirementText: trimmed,
      sourceFragment: null,
      derivationMethod: "single_statement",
      status: "ACTIVE",
    },
  ];
}

export class PisfService {
  private readonly repository: PisfRepository;

  public constructor(repository: PisfRepository) {
    this.repository = repository;
  }

  public async importFromRows(
    tx: PoolClient,
    input: ImportInput,
  ): Promise<ImportResult> {
    const existing = await this.repository.findLatestCompletedBatchByChecksum(
      input.sourceChecksum,
      tx,
    );
    const summary: ImportSummary = {
      created: 0,
      updated: 0,
      unchanged: 0,
      deactivated: 0,
      reactivated: 0,
      needs_review: 0,
      errors: 0,
    };

    const batch = await this.repository.createImportBatch(tx, {
      sourceFileName: input.sourceFileName,
      sourceChecksum: input.sourceChecksum,
      status: "STARTED",
    });

    if (existing && !input.force) {
      await this.repository.finalizeImportBatch(tx, {
        id: batch.id,
        status: "SKIPPED",
        summaryJson: summary,
        errorMessage: null,
      });
      return {
        batchId: batch.id,
        status: "SKIPPED",
        summary,
      };
    }

    const domainCodeToId = new Map<string, string>();
    const presentDomainCodes = new Set<string>();
    const presentControlCodes = new Set<string>();
    const presentRequirementKeys = new Set<string>();

    const domainMap = new Map<string, { name: string; description: string | null }>();
    for (const rawRow of input.rows) {
      const domain = String(rawRow.domain ?? "").trim();
      if (!domain) {
        continue;
      }
      const domainCode = toDomainCode(domain);
      domainMap.set(domainCode, {
        name: domain,
        description: null,
      });
    }

    for (const [domainCode, domainValue] of domainMap.entries()) {
      const upsert = await this.repository.upsertDomain(tx, {
        domainCode,
        name: domainValue.name,
        description: domainValue.description,
        sourceHash: sha256({
          domain_code: domainCode,
          name: domainValue.name,
          description: domainValue.description,
        }),
        lastImportBatchId: batch.id,
      });
      incrementSummary(summary, upsert.outcome);
      domainCodeToId.set(domainCode, upsert.id);
      presentDomainCodes.add(domainCode);
    }

    for (const rawRow of input.rows) {
      const controlCode = String(rawRow.controlCode ?? "").trim();
      const domainName = String(rawRow.domain ?? "").trim();
      const phase = String(rawRow.phase ?? "").trim();
      const area = String(rawRow.area ?? "").trim();
      const subArea = String(rawRow.subArea ?? "").trim();
      const title = String(rawRow.title ?? rawRow.shortSummary ?? "").trim();
      const sourceStatementText = String(rawRow.statement ?? "");
      const statementText = normalizeText(sourceStatementText);

      if (
        !controlCode ||
        !domainName ||
        !phase ||
        !area ||
        !subArea ||
        !title ||
        !statementText
      ) {
        summary.errors += 1;
        await this.repository.insertImportReviewItem(tx, {
          importBatchId: batch.id,
          sourceControlCode: controlCode || "UNKNOWN",
          issueType: "INVALID_SOURCE_ROW",
          message: "Required control fields are missing or empty.",
          rawSourceJson: rawRow,
        });
        continue;
      }

      const domainCode = toDomainCode(domainName);
      const domainId = domainCodeToId.get(domainCode);
      if (!domainId) {
        summary.errors += 1;
        await this.repository.insertImportReviewItem(tx, {
          importBatchId: batch.id,
          sourceControlCode: controlCode,
          issueType: "MISSING_DOMAIN",
          message: `Domain code ${domainCode} was not resolved during import.`,
          rawSourceJson: rawRow,
        });
        continue;
      }

      const controlUpsert = await this.repository.upsertControl(tx, {
        domainId,
        controlCode,
        phase,
        area,
        subArea,
        title,
        statementText,
        sourceStatementText,
        rawSourceJson: rawRow,
        sourceHash: sha256({
          domain_code: domainCode,
          control_code: controlCode,
          phase,
          area,
          sub_area: subArea,
          title,
          statement_text: statementText,
          source_statement_text: sourceStatementText,
          raw_source_json: rawRow,
        }),
        lastImportBatchId: batch.id,
      });
      incrementSummary(summary, controlUpsert.outcome);
      presentControlCodes.add(controlCode);

      const derivedRequirements = deriveRequirements(sourceStatementText);
      for (const requirement of derivedRequirements) {
        const requirementKey = `${controlCode}::${requirement.ordinal}`;
        const requirementUpsert = await this.repository.upsertRequirement(tx, {
          controlId: controlUpsert.id,
          requirementKey,
          ordinal: requirement.ordinal,
          requirementText: requirement.requirementText,
          sourceControlText: sourceStatementText,
          sourceFragment: requirement.sourceFragment,
          derivationMethod: requirement.derivationMethod,
          status: requirement.status,
          sourceHash: sha256({
            requirement_key: requirementKey,
            requirement_text: requirement.requirementText,
            source_control_text: sourceStatementText,
            source_fragment: requirement.sourceFragment,
            derivation_method: requirement.derivationMethod,
            status: requirement.status,
          }),
          lastImportBatchId: batch.id,
        });
        incrementSummary(summary, requirementUpsert.outcome);
        presentRequirementKeys.add(requirementKey);

        if (requirement.status === "NEEDS_REVIEW") {
          summary.needs_review += 1;
          await this.repository.insertImportReviewItem(tx, {
            importBatchId: batch.id,
            sourceControlCode: controlCode,
            issueType: "AMBIGUOUS_REQUIREMENT_DERIVATION",
            message:
              "Control statement could not be deterministically split into atomic obligations.",
            rawSourceJson: rawRow,
          });
        }
      }
    }

    summary.deactivated += await this.repository.deactivateMissingRequirements(
      tx,
      batch.id,
      [...presentRequirementKeys],
    );
    summary.deactivated += await this.repository.deactivateMissingControls(
      tx,
      batch.id,
      [...presentControlCodes],
    );
    summary.deactivated += await this.repository.deactivateMissingDomains(
      tx,
      batch.id,
      [...presentDomainCodes],
    );

    await this.repository.finalizeImportBatch(tx, {
      id: batch.id,
      status: "COMPLETED",
      summaryJson: summary,
      errorMessage: null,
    });

    return {
      batchId: batch.id,
      status: "COMPLETED",
      summary,
    };
  }

  public async listDomains(
    tx: PoolClient,
    claims: AuthClaims,
    input: PaginationInput,
  ): Promise<PaginatedResponse<unknown>> {
    await this.resolveActor(tx, claims);
    const page = this.normalizePage(input.page);
    const pageSize = this.normalizePageSize(input.pageSize);
    const result = await this.repository.listDomains(
      {
        limit: pageSize,
        offset: (page - 1) * pageSize,
        isAdmin: false,
      },
      tx,
    );
    return { page, pageSize, total: result.total, items: result.items };
  }

  public async getDomainById(
    tx: PoolClient,
    claims: AuthClaims,
    domainId: string,
  ): Promise<unknown> {
    await this.resolveActor(tx, claims);
    const item = await this.repository.getDomainById(domainId, tx);
    if (!item) {
      throw AUTH_ERRORS.PISF_RESOURCE_NOT_FOUND();
    }
    return item;
  }

  public async listControls(
    tx: PoolClient,
    claims: AuthClaims,
    input: ControlListInput,
  ): Promise<PaginatedResponse<unknown>> {
    await this.resolveActor(tx, claims);
    const page = this.normalizePage(input.page);
    const pageSize = this.normalizePageSize(input.pageSize);
    const result = await this.repository.listControls(
      {
        domainId: input.domainId ?? null,
        phase: input.phase ?? null,
        search: input.search ?? null,
        limit: pageSize,
        offset: (page - 1) * pageSize,
        isAdmin: false,
      },
      tx,
    );
    return { page, pageSize, total: result.total, items: result.items };
  }

  public async getControlById(
    tx: PoolClient,
    claims: AuthClaims,
    controlId: string,
  ): Promise<unknown> {
    await this.resolveActor(tx, claims);
    const item = await this.repository.getControlById(controlId, tx);
    if (!item) {
      throw AUTH_ERRORS.PISF_RESOURCE_NOT_FOUND();
    }
    return item;
  }

  public async listRequirements(
    tx: PoolClient,
    claims: AuthClaims,
    input: RequirementListInput,
  ): Promise<PaginatedResponse<unknown>> {
    const actor = await this.resolveActor(tx, claims);
    const isAdmin = actor.role === "admin";
    const normalizedStatus = this.normalizeRequirementStatus(input.status, isAdmin);

    const page = this.normalizePage(input.page);
    const pageSize = this.normalizePageSize(input.pageSize);
    const result = await this.repository.listRequirements(
      {
        domainId: input.domainId ?? null,
        controlId: input.controlId ?? null,
        status: normalizedStatus,
        limit: pageSize,
        offset: (page - 1) * pageSize,
        isAdmin,
      },
      tx,
    );
    return { page, pageSize, total: result.total, items: result.items };
  }

  public async getRequirementById(
    tx: PoolClient,
    claims: AuthClaims,
    requirementId: string,
  ): Promise<unknown> {
    const actor = await this.resolveActor(tx, claims);
    const item = await this.repository.getRequirementById(
      requirementId,
      actor.role === "admin",
      tx,
    );
    if (!item) {
      throw AUTH_ERRORS.PISF_RESOURCE_NOT_FOUND();
    }
    return item;
  }

  private async resolveActor(
    tx: PoolClient,
    claims: AuthClaims,
  ): Promise<{ role: string }> {
    const actor = await this.repository.findActorRole(claims.userId, tx);
    if (!actor || actor.org_id !== claims.orgId) {
      throw AUTH_ERRORS.UNAUTHORIZED();
    }
    return { role: actor.role };
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

  private normalizeRequirementStatus(
    requestedStatus: string | undefined,
    isAdmin: boolean,
  ): RequirementStatus {
    if (!requestedStatus) {
      return "ACTIVE";
    }
    const upper = requestedStatus.toUpperCase();
    if (!isAdmin) {
      return "ACTIVE";
    }
    if (upper === "ACTIVE" || upper === "NEEDS_REVIEW" || upper === "DEPRECATED") {
      return upper;
    }
    return "ACTIVE";
  }
}

export type { ImportResult, ImportSummary, SourceControlRow };
