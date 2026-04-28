import type { Pool, PoolClient } from "pg";

import { AUTH_ERRORS } from "../auth/errors.js";

type QueryExecutor = Pick<Pool, "query"> | Pick<PoolClient, "query">;

type ImportBatchStatus = "STARTED" | "COMPLETED" | "FAILED" | "SKIPPED";
type DerivationMethod =
  | "deterministic_split"
  | "single_statement"
  | "manual_review_required";
type RequirementStatus = "ACTIVE" | "NEEDS_REVIEW" | "DEPRECATED";
type UpsertOutcome = "created" | "updated" | "unchanged" | "reactivated";

type ImportBatchRecord = {
  id: string;
  source_file_name: string;
  source_checksum: string;
  status: ImportBatchStatus;
  started_at: Date;
  completed_at: Date | null;
  summary_json: Record<string, unknown>;
  error_message: string | null;
};

type DomainImportInput = {
  domainCode: string;
  name: string;
  description: string | null;
  sourceHash: string;
  lastImportBatchId: string;
};

type ControlImportInput = {
  domainId: string;
  controlCode: string;
  phase: string;
  area: string;
  subArea: string;
  title: string;
  statementText: string;
  sourceStatementText: string;
  rawSourceJson: Record<string, unknown>;
  sourceHash: string;
  lastImportBatchId: string;
};

type RequirementImportInput = {
  controlId: string;
  requirementKey: string;
  ordinal: number;
  requirementText: string;
  sourceControlText: string;
  sourceFragment: string | null;
  derivationMethod: DerivationMethod;
  status: RequirementStatus;
  sourceHash: string;
  lastImportBatchId: string;
};

type ImportReviewItemInput = {
  importBatchId: string;
  sourceControlCode: string;
  issueType: string;
  message: string;
  rawSourceJson: Record<string, unknown>;
};

type PisfDomain = {
  id: string;
  domain_code: string;
  name: string;
  description: string | null;
  is_active: boolean;
  deprecated_at: Date | null;
  source_hash: string;
  last_import_batch_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type PisfControl = {
  id: string;
  domain_id: string;
  control_code: string;
  phase: string;
  area: string;
  sub_area: string;
  title: string;
  statement_text: string;
  source_statement_text: string;
  raw_source_json: Record<string, unknown>;
  is_active: boolean;
  deprecated_at: Date | null;
  source_hash: string;
  last_import_batch_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type PisfRequirement = {
  id: string;
  control_id: string;
  requirement_key: string;
  ordinal: number;
  requirement_text: string;
  source_control_text: string;
  source_fragment: string | null;
  derivation_method: DerivationMethod;
  status: RequirementStatus;
  is_active: boolean;
  deprecated_at: Date | null;
  source_hash: string;
  last_import_batch_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type PaginatedResult<T> = {
  total: number;
  items: T[];
};

type DomainListQuery = {
  limit: number;
  offset: number;
  isAdmin: boolean;
};

type ControlListQuery = {
  domainId: string | null;
  phase: string | null;
  search: string | null;
  limit: number;
  offset: number;
  isAdmin: boolean;
};

type RequirementListQuery = {
  domainId: string | null;
  controlId: string | null;
  status: RequirementStatus;
  limit: number;
  offset: number;
  isAdmin: boolean;
};

type ActorRole = {
  user_id: string;
  org_id: string;
  role: string;
};

function assertTx(tx?: PoolClient): PoolClient {
  if (!tx) {
    throw AUTH_ERRORS.MISSING_TX_CONTEXT();
  }
  return tx;
}

function sameNullableText(left: string | null, right: string | null): boolean {
  return (left ?? null) === (right ?? null);
}

function asNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number(value);
  }
  return 0;
}

export class PisfRepository {
  private readonly readExecutor: QueryExecutor;

  public constructor(readExecutor: QueryExecutor) {
    this.readExecutor = readExecutor;
  }

  public async findLatestCompletedBatchByChecksum(
    checksum: string,
    tx?: PoolClient,
  ): Promise<ImportBatchRecord | null> {
    const executor = tx ?? this.readExecutor;
    const result = await executor.query<ImportBatchRecord>(
      `
      SELECT
        id,
        source_file_name,
        source_checksum,
        status,
        started_at,
        completed_at,
        summary_json,
        error_message
      FROM pisf_import_batches
      WHERE source_checksum = $1
        AND status = 'COMPLETED'
      ORDER BY completed_at DESC
      LIMIT 1
      `,
      [checksum],
    );
    return result.rows[0] ?? null;
  }

  public async createImportBatch(
    tx: PoolClient | undefined,
    input: {
      sourceFileName: string;
      sourceChecksum: string;
      status: ImportBatchStatus;
    },
  ): Promise<ImportBatchRecord> {
    const client = assertTx(tx);
    const result = await client.query<ImportBatchRecord>(
      `
      INSERT INTO pisf_import_batches (
        source_file_name,
        source_checksum,
        status
      )
      VALUES ($1, $2, $3)
      RETURNING
        id,
        source_file_name,
        source_checksum,
        status,
        started_at,
        completed_at,
        summary_json,
        error_message
      `,
      [input.sourceFileName, input.sourceChecksum, input.status],
    );
    return result.rows[0];
  }

  public async finalizeImportBatch(
    tx: PoolClient | undefined,
    input: {
      id: string;
      status: ImportBatchStatus;
      summaryJson: Record<string, unknown>;
      errorMessage: string | null;
    },
  ): Promise<void> {
    const client = assertTx(tx);
    await client.query(
      `
      UPDATE pisf_import_batches
      SET status = $2,
          summary_json = $3::jsonb,
          error_message = $4,
          completed_at = now()
      WHERE id = $1
      `,
      [input.id, input.status, JSON.stringify(input.summaryJson), input.errorMessage],
    );
  }

  public async upsertDomain(
    tx: PoolClient | undefined,
    input: DomainImportInput,
  ): Promise<{ id: string; outcome: UpsertOutcome }> {
    const client = assertTx(tx);
    const existing = await client.query<PisfDomain>(
      `
      SELECT *
      FROM pisf_domains
      WHERE domain_code = $1
      FOR UPDATE
      `,
      [input.domainCode],
    );
    const row = existing.rows[0];
    if (!row) {
      const created = await client.query<{ id: string }>(
        `
        INSERT INTO pisf_domains (
          domain_code,
          name,
          description,
          is_active,
          deprecated_at,
          source_hash,
          last_import_batch_id
        )
        VALUES ($1, $2, $3, TRUE, NULL, $4, $5)
        RETURNING id
        `,
        [
          input.domainCode,
          input.name,
          input.description,
          input.sourceHash,
          input.lastImportBatchId,
        ],
      );
      return { id: created.rows[0].id, outcome: "created" };
    }

    const changed =
      row.source_hash !== input.sourceHash ||
      row.name !== input.name ||
      !sameNullableText(row.description, input.description) ||
      !row.is_active;

    const outcome: UpsertOutcome = !row.is_active
      ? "reactivated"
      : changed
        ? "updated"
        : "unchanged";

    await client.query(
      `
      UPDATE pisf_domains
      SET
        name = $2,
        description = $3,
        is_active = TRUE,
        deprecated_at = NULL,
        source_hash = $4,
        last_import_batch_id = $5
      WHERE id = $1
      `,
      [row.id, input.name, input.description, input.sourceHash, input.lastImportBatchId],
    );

    return { id: row.id, outcome };
  }

  public async upsertControl(
    tx: PoolClient | undefined,
    input: ControlImportInput,
  ): Promise<{ id: string; outcome: UpsertOutcome }> {
    const client = assertTx(tx);
    const existing = await client.query<PisfControl>(
      `
      SELECT *
      FROM pisf_controls
      WHERE control_code = $1
      FOR UPDATE
      `,
      [input.controlCode],
    );
    const row = existing.rows[0];

    if (!row) {
      const created = await client.query<{ id: string }>(
        `
        INSERT INTO pisf_controls (
          domain_id,
          control_code,
          phase,
          area,
          sub_area,
          title,
          statement_text,
          source_statement_text,
          raw_source_json,
          is_active,
          deprecated_at,
          source_hash,
          last_import_batch_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, TRUE, NULL, $10, $11)
        RETURNING id
        `,
        [
          input.domainId,
          input.controlCode,
          input.phase,
          input.area,
          input.subArea,
          input.title,
          input.statementText,
          input.sourceStatementText,
          JSON.stringify(input.rawSourceJson),
          input.sourceHash,
          input.lastImportBatchId,
        ],
      );
      return { id: created.rows[0].id, outcome: "created" };
    }

    const changed =
      row.source_hash !== input.sourceHash ||
      row.domain_id !== input.domainId ||
      !row.is_active;

    const outcome: UpsertOutcome = !row.is_active
      ? "reactivated"
      : changed
        ? "updated"
        : "unchanged";

    await client.query(
      `
      UPDATE pisf_controls
      SET
        domain_id = $2,
        phase = $3,
        area = $4,
        sub_area = $5,
        title = $6,
        statement_text = $7,
        source_statement_text = $8,
        raw_source_json = $9::jsonb,
        is_active = TRUE,
        deprecated_at = NULL,
        source_hash = $10,
        last_import_batch_id = $11
      WHERE id = $1
      `,
      [
        row.id,
        input.domainId,
        input.phase,
        input.area,
        input.subArea,
        input.title,
        input.statementText,
        input.sourceStatementText,
        JSON.stringify(input.rawSourceJson),
        input.sourceHash,
        input.lastImportBatchId,
      ],
    );

    return { id: row.id, outcome };
  }

  public async upsertRequirement(
    tx: PoolClient | undefined,
    input: RequirementImportInput,
  ): Promise<{ id: string; outcome: UpsertOutcome }> {
    const client = assertTx(tx);
    const existing = await client.query<PisfRequirement>(
      `
      SELECT *
      FROM pisf_requirements
      WHERE requirement_key = $1
      FOR UPDATE
      `,
      [input.requirementKey],
    );
    const row = existing.rows[0];

    if (!row) {
      const created = await client.query<{ id: string }>(
        `
        INSERT INTO pisf_requirements (
          control_id,
          requirement_key,
          ordinal,
          requirement_text,
          source_control_text,
          source_fragment,
          derivation_method,
          status,
          is_active,
          deprecated_at,
          source_hash,
          last_import_batch_id
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, TRUE, NULL, $9, $10
        )
        RETURNING id
        `,
        [
          input.controlId,
          input.requirementKey,
          input.ordinal,
          input.requirementText,
          input.sourceControlText,
          input.sourceFragment,
          input.derivationMethod,
          input.status,
          input.sourceHash,
          input.lastImportBatchId,
        ],
      );
      return { id: created.rows[0].id, outcome: "created" };
    }

    const changed =
      row.source_hash !== input.sourceHash ||
      row.control_id !== input.controlId ||
      row.status !== input.status ||
      !row.is_active;

    const outcome: UpsertOutcome = !row.is_active
      ? "reactivated"
      : changed
        ? "updated"
        : "unchanged";

    await client.query(
      `
      UPDATE pisf_requirements
      SET
        control_id = $2,
        ordinal = $3,
        requirement_text = $4,
        source_control_text = $5,
        source_fragment = $6,
        derivation_method = $7,
        status = $8,
        is_active = TRUE,
        deprecated_at = NULL,
        source_hash = $9,
        last_import_batch_id = $10
      WHERE id = $1
      `,
      [
        row.id,
        input.controlId,
        input.ordinal,
        input.requirementText,
        input.sourceControlText,
        input.sourceFragment,
        input.derivationMethod,
        input.status,
        input.sourceHash,
        input.lastImportBatchId,
      ],
    );

    return { id: row.id, outcome };
  }

  public async insertImportReviewItem(
    tx: PoolClient | undefined,
    input: ImportReviewItemInput,
  ): Promise<void> {
    const client = assertTx(tx);
    await client.query(
      `
      INSERT INTO pisf_import_review_items (
        import_batch_id,
        source_control_code,
        issue_type,
        message,
        raw_source_json
      )
      VALUES ($1, $2, $3, $4, $5::jsonb)
      `,
      [
        input.importBatchId,
        input.sourceControlCode,
        input.issueType,
        input.message,
        JSON.stringify(input.rawSourceJson),
      ],
    );
  }

  public async deactivateMissingDomains(
    tx: PoolClient | undefined,
    batchId: string,
    presentDomainCodes: string[],
  ): Promise<number> {
    const client = assertTx(tx);
    const result = presentDomainCodes.length > 0
      ? await client.query(
          `
          UPDATE pisf_domains
          SET
            is_active = FALSE,
            deprecated_at = now(),
            last_import_batch_id = $1
          WHERE is_active = TRUE
            AND NOT (domain_code = ANY($2::text[]))
          `,
          [batchId, presentDomainCodes],
        )
      : await client.query(
          `
          UPDATE pisf_domains
          SET
            is_active = FALSE,
            deprecated_at = now(),
            last_import_batch_id = $1
          WHERE is_active = TRUE
          `,
          [batchId],
        );
    return result.rowCount ?? 0;
  }

  public async deactivateMissingControls(
    tx: PoolClient | undefined,
    batchId: string,
    presentControlCodes: string[],
  ): Promise<number> {
    const client = assertTx(tx);
    const result = presentControlCodes.length > 0
      ? await client.query(
          `
          UPDATE pisf_controls
          SET
            is_active = FALSE,
            deprecated_at = now(),
            last_import_batch_id = $1
          WHERE is_active = TRUE
            AND NOT (control_code = ANY($2::text[]))
          `,
          [batchId, presentControlCodes],
        )
      : await client.query(
          `
          UPDATE pisf_controls
          SET
            is_active = FALSE,
            deprecated_at = now(),
            last_import_batch_id = $1
          WHERE is_active = TRUE
          `,
          [batchId],
        );
    return result.rowCount ?? 0;
  }

  public async deactivateMissingRequirements(
    tx: PoolClient | undefined,
    batchId: string,
    presentRequirementKeys: string[],
  ): Promise<number> {
    const client = assertTx(tx);
    const result = presentRequirementKeys.length > 0
      ? await client.query(
          `
          UPDATE pisf_requirements
          SET
            status = 'DEPRECATED',
            is_active = FALSE,
            deprecated_at = now(),
            last_import_batch_id = $1
          WHERE is_active = TRUE
            AND NOT (requirement_key = ANY($2::text[]))
          `,
          [batchId, presentRequirementKeys],
        )
      : await client.query(
          `
          UPDATE pisf_requirements
          SET
            status = 'DEPRECATED',
            is_active = FALSE,
            deprecated_at = now(),
            last_import_batch_id = $1
          WHERE is_active = TRUE
          `,
          [batchId],
        );
    return result.rowCount ?? 0;
  }

  public async findActorRole(
    userId: string,
    executor?: QueryExecutor,
  ): Promise<ActorRole | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<ActorRole>(
      `
      SELECT
        id AS user_id,
        org_id,
        role
      FROM users
      WHERE id = $1
      `,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  public async listDomains(
    query: DomainListQuery,
    executor?: QueryExecutor,
  ): Promise<PaginatedResult<PisfDomain>> {
    const db = executor ?? this.readExecutor;
    const totalResult = await db.query<{ total: string }>(
      `
      SELECT count(*)::text AS total
      FROM pisf_domains
      WHERE is_active = TRUE
      `,
    );
    const itemsResult = await db.query<PisfDomain>(
      `
      SELECT *
      FROM pisf_domains
      WHERE is_active = TRUE
      ORDER BY domain_code ASC
      LIMIT $1 OFFSET $2
      `,
      [query.limit, query.offset],
    );
    return {
      total: asNumber(totalResult.rows[0]?.total),
      items: itemsResult.rows,
    };
  }

  public async getDomainById(
    domainId: string,
    executor?: QueryExecutor,
  ): Promise<PisfDomain | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<PisfDomain>(
      `
      SELECT *
      FROM pisf_domains
      WHERE id = $1
        AND is_active = TRUE
      `,
      [domainId],
    );
    return result.rows[0] ?? null;
  }

  public async listControls(
    query: ControlListQuery,
    executor?: QueryExecutor,
  ): Promise<PaginatedResult<PisfControl>> {
    const db = executor ?? this.readExecutor;
    const conditions: string[] = ["c.is_active = TRUE"];
    const params: unknown[] = [];

    if (query.domainId) {
      params.push(query.domainId);
      conditions.push(`c.domain_id = $${params.length}`);
    }
    if (query.phase) {
      params.push(query.phase);
      conditions.push(`c.phase = $${params.length}`);
    }
    if (query.search) {
      params.push(`%${query.search.toLowerCase()}%`);
      const idx = params.length;
      conditions.push(
        `(lower(c.control_code) LIKE $${idx} OR lower(c.title) LIKE $${idx} OR lower(c.statement_text) LIKE $${idx})`,
      );
    }
    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const totalQuery = `
      SELECT count(*)::text AS total
      FROM pisf_controls c
      ${whereClause}
    `;
    const totalResult = await db.query<{ total: string }>(totalQuery, params);

    params.push(query.limit);
    params.push(query.offset);
    const listQuery = `
      SELECT c.*
      FROM pisf_controls c
      ${whereClause}
      ORDER BY c.control_code ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const itemsResult = await db.query<PisfControl>(listQuery, params);
    return {
      total: asNumber(totalResult.rows[0]?.total),
      items: itemsResult.rows,
    };
  }

  public async getControlById(
    controlId: string,
    executor?: QueryExecutor,
  ): Promise<PisfControl | null> {
    const db = executor ?? this.readExecutor;
    const result = await db.query<PisfControl>(
      `
      SELECT *
      FROM pisf_controls
      WHERE id = $1
        AND is_active = TRUE
      `,
      [controlId],
    );
    return result.rows[0] ?? null;
  }

  public async listRequirements(
    query: RequirementListQuery,
    executor?: QueryExecutor,
  ): Promise<PaginatedResult<PisfRequirement>> {
    const db = executor ?? this.readExecutor;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.status === "DEPRECATED" && query.isAdmin) {
      conditions.push(`r.status = 'DEPRECATED'`);
    } else {
      conditions.push("r.is_active = TRUE");
      params.push(query.status);
      conditions.push(`r.status = $${params.length}`);
    }

    if (query.controlId) {
      params.push(query.controlId);
      conditions.push(`r.control_id = $${params.length}`);
    }

    if (query.domainId) {
      params.push(query.domainId);
      conditions.push(`c.domain_id = $${params.length}`);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;
    const totalQuery = `
      SELECT count(*)::text AS total
      FROM pisf_requirements r
      JOIN pisf_controls c ON c.id = r.control_id
      ${whereClause}
    `;
    const totalResult = await db.query<{ total: string }>(totalQuery, params);

    params.push(query.limit);
    params.push(query.offset);
    const listQuery = `
      SELECT r.*
      FROM pisf_requirements r
      JOIN pisf_controls c ON c.id = r.control_id
      ${whereClause}
      ORDER BY r.requirement_key ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const itemsResult = await db.query<PisfRequirement>(listQuery, params);
    return {
      total: asNumber(totalResult.rows[0]?.total),
      items: itemsResult.rows,
    };
  }

  public async getRequirementById(
    requirementId: string,
    isAdmin: boolean,
    executor?: QueryExecutor,
  ): Promise<PisfRequirement | null> {
    const db = executor ?? this.readExecutor;
    const result = isAdmin
      ? await db.query<PisfRequirement>(
          `
          SELECT *
          FROM pisf_requirements
          WHERE id = $1
          `,
          [requirementId],
        )
      : await db.query<PisfRequirement>(
          `
          SELECT *
          FROM pisf_requirements
          WHERE id = $1
            AND is_active = TRUE
            AND status = 'ACTIVE'
          `,
          [requirementId],
        );
    return result.rows[0] ?? null;
  }
}

export type {
  ActorRole,
  ControlImportInput,
  DerivationMethod,
  DomainImportInput,
  ImportBatchRecord,
  ImportBatchStatus,
  ImportReviewItemInput,
  PaginatedResult,
  PisfControl,
  PisfDomain,
  PisfRequirement,
  RequirementImportInput,
  RequirementStatus,
  UpsertOutcome,
};
