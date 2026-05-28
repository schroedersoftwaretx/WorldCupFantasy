/**
 * Database handle for the web app.
 *
 * The Next.js dev server hot-reloads modules on every edit; a naive
 * `createDb()` at module scope would leak a fresh connection pool on each
 * reload. Memoizing the `Db` on `globalThis` keeps a single pool alive
 * across reloads. In production (one long-lived process) it is simply a
 * lazily-created singleton.
 *
 * The connection string comes from `DATABASE_URL`. It is read lazily - on
 * first use, not at import time - so the app can be built without a
 * database present (every page and route is `force-dynamic`).
 *
 * --- Vercel serverless connection handling ---
 *
 * On Vercel, each function invocation may run in a fresh Node.js process
 * (a "cold start"). A large pg.Pool (e.g. max: 4) can therefore open up to
 * 4 connections per concurrent cold-start invocation. On Neon's free tier
 * (10 connection limit) this exhausts the limit quickly. We cap the pool at
 * max: 1 whenever Vercel sets VERCEL=1 in the runtime environment.
 *
 * For the same reason, DATABASE_URL in production should point to Neon's
 * connection pooler URL (the hostname contains "-pooler."), not the direct
 * connection URL. See DEPLOY.md for the distinction.
 */
import { createDb, type Db } from "../data/db/client.js";

const globalForDb = globalThis as unknown as { __wcDb?: Db };

/**
 * Return the process-wide `Db`, creating it on first call. Throws if
 * `DATABASE_URL` is not set.
 */
export function getDb(): Db {
  if (globalForDb.__wcDb) return globalForDb.__wcDb;

  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set - the web app cannot reach a database",
    );
  }

  // On Vercel serverless use a single connection per process to avoid
  // exhausting Neon's connection limit across concurrent cold starts.
  // Locally (and in long-lived server processes) 4 is fine.
  const isVercel = process.env["VERCEL"] === "1";
  const max = isVercel ? 1 : 4;

  const db = createDb({ connectionString, max });
  globalForDb.__wcDb = db;
  return db;
}
