import type { Pool, PoolClient } from "pg";

type TransactionHandler<T> = (tx: PoolClient) => Promise<T>;

type PgError = Error & { code?: string };

export class TransactionExecutionError extends Error {
  public readonly timeout: boolean;
  public readonly rollbackConfirmed: boolean;
  public readonly commitAttempted: boolean;
  public readonly cause: unknown;

  public constructor(
    cause: unknown,
    timeout: boolean,
    rollbackConfirmed: boolean,
    commitAttempted: boolean,
  ) {
    const causeMessage =
      cause instanceof Error ? cause.message : "Transaction failed";
    super(causeMessage);
    this.name = "TransactionExecutionError";
    this.timeout = timeout;
    this.rollbackConfirmed = rollbackConfirmed;
    this.commitAttempted = commitAttempted;
    this.cause = cause;
  }
}

function isTimeoutError(err: unknown): boolean {
  const pgErr = err as PgError;
  const message = String(pgErr?.message ?? "").toLowerCase();

  return (
    pgErr?.code === "57014" ||
    pgErr?.code === "25P03" ||
    message.includes("statement timeout") ||
    message.includes("idle-in-transaction timeout")
  );
}

export async function withTransaction<T>(
  pool: Pool,
  handler: TransactionHandler<T>,
  txOverride?: PoolClient,
): Promise<T> {
  if (txOverride) {
    return handler(txOverride);
  }

  const client = await pool.connect();
  let began = false;
  let destroyClient = false;
  let commitAttempted = false;

  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");

    const result = await handler(client);
    commitAttempted = true;
    await client.query("COMMIT");
    began = false;
    return result;
  } catch (err) {
    const timeout = isTimeoutError(err);
    if (timeout) {
      destroyClient = true;
    }

    let rollbackConfirmed = false;
    if (began) {
      try {
        await client.query("ROLLBACK");
        rollbackConfirmed = true;
      } catch {
        destroyClient = true;
      }
    }
    throw new TransactionExecutionError(
      err,
      timeout,
      rollbackConfirmed,
      commitAttempted,
    );
  } finally {
    client.release(destroyClient);
  }
}
