import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import { PisfRepository } from "../../backend/src/pisf/repository.js";
import { PisfService, type SourceControlRow } from "../../backend/src/pisf/service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv: string[]): { file: string; force: boolean } {
  let file = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "legacy",
    "src",
    "data",
    "controls.json",
  );
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--force") {
      force = true;
      continue;
    }
    if (token === "--file") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --file");
      }
      file = path.resolve(process.cwd(), next);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return { file, force };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const args = parseArgs(process.argv.slice(2));
  const content = await readFile(args.file, "utf8");
  const sourceChecksum = sha256(content);
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error("Source JSON must be an array");
  }
  const rows = parsed as SourceControlRow[];

  const requestedPoolMax = Number(process.env.DB_POOL_MAX ?? 10);
  const poolMax = Number.isFinite(requestedPoolMax)
    ? Math.min(Math.max(requestedPoolMax, 1), 20)
    : 10;
  const connectionTimeoutMillis = Number(process.env.DB_POOL_CONNECTION_TIMEOUT_MS ?? 5000);

  const pool = new Pool({
    connectionString: databaseUrl,
    max: poolMax,
    connectionTimeoutMillis: Number.isFinite(connectionTimeoutMillis)
      ? connectionTimeoutMillis
      : 5000,
  });

  const repository = new PisfRepository(pool);
  const service = new PisfService(repository);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");

    const result = await service.importFromRows(client, {
      sourceFileName: path.basename(args.file),
      sourceChecksum,
      force: args.force,
      rows,
    });

    await client.query("COMMIT");

    console.log(`PISF import status: ${result.status}`);
    console.log(`batch_id: ${result.batchId}`);
    console.log(`created: ${result.summary.created}`);
    console.log(`updated: ${result.summary.updated}`);
    console.log(`unchanged: ${result.summary.unchanged}`);
    console.log(`deactivated: ${result.summary.deactivated}`);
    console.log(`reactivated: ${result.summary.reactivated}`);
    console.log(`needs_review: ${result.summary.needs_review}`);
    console.log(`errors: ${result.summary.errors}`);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback errors here, surface original failure.
    }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("PISF import failed.");
  console.error(err);
  process.exitCode = 1;
});
