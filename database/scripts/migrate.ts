import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

type AppliedMigration = {
  name: string;
  checksum: string;
};

type PgError = Error & { code?: string };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const migrationsDir =
  process.env.MIGRATIONS_DIR ??
  path.resolve(__dirname, "..", "migrations");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const requestedPoolMax = Number(process.env.DB_POOL_MAX ?? 10);
const poolMax = Number.isFinite(requestedPoolMax)
  ? Math.min(Math.max(requestedPoolMax, 1), 20)
  : 10;

const connectionTimeoutMillis = Number(
  process.env.DB_POOL_CONNECTION_TIMEOUT_MS ?? 5000
);

const pool = new Pool({
  connectionString: databaseUrl,
  max: poolMax,
  connectionTimeoutMillis: Number.isFinite(connectionTimeoutMillis)
    ? connectionTimeoutMillis
    : 5000,
});

const MIGRATION_LOCK_ID = 823746123;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isTimeoutError(err: unknown): boolean {
  const pgErr = err as PgError;
  const code = pgErr?.code;
  const message = String(pgErr?.message ?? "").toLowerCase();

  return (
    code === "57014" || // statement timeout / query canceled
    code === "25P03" || // idle_in_transaction_session_timeout
    message.includes("statement timeout") ||
    message.includes("idle-in-transaction timeout")
  );
}

async function ensureMigrationsTable(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  } finally {
    client.release();
  }
}

async function readMigrationFiles(): Promise<string[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^\d+.*\.sql$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function loadAppliedMigrations(): Promise<Map<string, string>> {
  const client = await pool.connect();
  try {
    const result = await client.query<AppliedMigration>(
      "SELECT name, checksum FROM schema_migrations ORDER BY name ASC"
    );
    return new Map(result.rows.map((row) => [row.name, row.checksum]));
  } finally {
    client.release();
  }
}

async function withMigrationLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockClient = await pool.connect();
  try {
    console.log("Acquiring migration advisory lock...");
    await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    console.log("Migration advisory lock acquired.");

    const result = await fn();

    return result;
  } finally {
    try {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
      console.log("Migration advisory lock released.");
    } catch (unlockErr) {
      console.error("Failed to release migration advisory lock.", unlockErr);
    }
    lockClient.release();
  }
}

async function applyMigration(fileName: string, sql: string, checksum: string): Promise<void> {
  const client = await pool.connect();
  let begun = false;
  let destroyClient = false;

  try {
    // BEGIN immediately before first DB operation in this migration transaction
    await client.query("BEGIN");
    begun = true;

    // Runtime safety inside transaction scope
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");

    await client.query(sql);

    await client.query(
      "INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)",
      [fileName, checksum]
    );

    await client.query("COMMIT");
    begun = false;
  } catch (err) {
    if (isTimeoutError(err)) {
      destroyClient = true;
    }

    if (begun) {
      try {
        await client.query("ROLLBACK");
        begun = false;
      } catch {
        destroyClient = true;
      }
    }

    throw err;
  } finally {
    client.release(destroyClient);
  }
}

async function runMigrations(): Promise<void> {
  await ensureMigrationsTable();

  await withMigrationLock(async () => {
    const files = await readMigrationFiles();
    const applied = await loadAppliedMigrations();

    for (const fileName of files) {
      const fullPath = path.join(migrationsDir, fileName);
      const sql = await readFile(fullPath, "utf8");
      const checksum = sha256(sql);

      const priorChecksum = applied.get(fileName);
      if (priorChecksum) {
        if (priorChecksum !== checksum) {
          throw new Error(
            `Checksum mismatch for applied migration ${fileName}. ` +
              `Expected ${priorChecksum}, got ${checksum}.`
          );
        }
        continue;
      }

      console.log(`Applying migration: ${fileName}`);
      await applyMigration(fileName, sql, checksum);
      console.log(`Applied migration: ${fileName}`);
    }
  });
}

async function main(): Promise<void> {
  try {
    await runMigrations();
    console.log("Migration run complete.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration run failed.");
  console.error(err);
  process.exitCode = 1;
});
