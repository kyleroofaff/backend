import { Pool } from "pg";
import { env } from "../config/env.js";

let pool = null;

export function hasPostgresConfig() {
  return Boolean(env.databaseUrl);
}

export function getPgPool() {
  if (!hasPostgresConfig()) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: env.databaseUrl,
      ssl: env.databaseSslRequire ? { rejectUnauthorized: false } : false
    });
  }
  return pool;
}

export async function pgQuery(text, params = []) {
  const currentPool = getPgPool();
  if (!currentPool) {
    throw new Error("DATABASE_URL is not configured.");
  }
  return currentPool.query(text, params);
}

export async function withPgTransaction(run) {
  const currentPool = getPgPool();
  if (!currentPool) {
    throw new Error("DATABASE_URL is not configured.");
  }
  const client = await currentPool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
