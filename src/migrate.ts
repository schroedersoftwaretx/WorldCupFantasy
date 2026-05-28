/**
 * Apply Drizzle migrations against $DATABASE_URL.
 *
 * Usage:
 *   node --env-file=.env --import tsx src/migrate.ts
 *   # or: npm run migrate
 *
 * Re-running is safe -- applied migrations are tracked in
 * `drizzle.__drizzle_migrations` and skipped on subsequent runs.
 */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

import { closeDb, createDb } from "./data/db/client.js";

export async function runMigrations(connectionString: string, migrationsFolder?: string): Promise<void> {
  const folder =
    migrationsFolder ??
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
  const db = createDb({ connectionString, max: 2 });
  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await closeDb(db);
  }
}

// Run when invoked directly via `npm run migrate`. The string comparison
// must go through pathToFileURL - on Windows process.argv[1] uses backslashes
// while import.meta.url is a forward-slash file:// URL, so a plain `===`
// check silently fails and the migration never runs.
const entryPath = process.argv[1];
const isMain =
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(entryPath).href;

if (isMain) {
  // Prefer DIRECT_DATABASE_URL when set. In production (Neon) DATABASE_URL
  // points at the pgbouncer pooler which runs in transaction mode -- DDL
  // statements inside a migration may fail under that mode. The direct URL
  // bypasses pgbouncer and is safe for schema migrations.
  const url =
    process.env["DIRECT_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  if (!url) {
    console.error("Neither DIRECT_DATABASE_URL nor DATABASE_URL is set");
    process.exit(1);
  }
  runMigrations(url).then(
    () => {
      console.log("migrations applied");
      process.exit(0);
    },
    (err) => {
      console.error("migration failed:", err);
      process.exit(1);
    },
  );
}
