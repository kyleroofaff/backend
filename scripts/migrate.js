import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withPgTransaction } from "../src/db/postgres.js";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(scriptsDir, "../migrations");

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedVersions(client) {
  const result = await client.query("SELECT version FROM schema_migrations");
  return new Set(result.rows.map((row) => row.version));
}

async function run() {
  const files = (await fs.readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  if (!files.length) {
    console.log("No migrations found.");
    return;
  }

  await withPgTransaction(async (client) => {
    await ensureMigrationsTable(client);
    const applied = await getAppliedVersions(client);

    for (const file of files) {
      if (applied.has(file)) continue;
      const sqlPath = path.join(migrationsDir, file);
      const sql = await fs.readFile(sqlPath, "utf8");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations(version) VALUES($1)",
        [file]
      );
      console.log(`Applied migration: ${file}`);
    }
  });
}

run()
  .then(() => {
    console.log("Migrations complete.");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Migration failed:", error);
    process.exit(1);
  });
