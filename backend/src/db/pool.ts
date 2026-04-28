import { Pool } from "pg";

export function createPool(connectionString: string): Pool {
  const requestedMax = Number(process.env.DB_POOL_MAX ?? 10);
  const max = Number.isFinite(requestedMax)
    ? Math.min(Math.max(requestedMax, 1), 20)
    : 10;

  const timeoutMs = Number(process.env.DB_POOL_CONNECTION_TIMEOUT_MS ?? 5000);

  return new Pool({
    connectionString,
    max,
    connectionTimeoutMillis: Number.isFinite(timeoutMs) ? timeoutMs : 5000,
  });
}
