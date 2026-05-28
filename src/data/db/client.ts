/**
 * Postgres client wrapper.
 *
 * Centralizes Pool construction so both the CLI and tests build their drizzle
 * instance the same way. Callers pass in a connection string explicitly so
 * tests (which use a Testcontainers-provided URL) don't depend on env state.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema> & { $pool: pg.Pool };

/**
 * The transaction handle passed to a `db.transaction(async (tx) => ...)`
 * callback. Service functions that need to compose other services'
 * writes into one atomic unit accept a `DbTx` for their core logic, while
 * exposing a `Db`-accepting wrapper that opens the transaction. Derived
 * directly from `Db.transaction` so it stays correct if drizzle's types
 * shift.
 */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface CreateDbOptions {
  /** Postgres connection string. */
  connectionString: string;
  /** Optional pool max - keep small (1-4) for CLI/worker contexts. */
  max?: number;
}

export function createDb(opts: CreateDbOptions): Db {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 4,
  });
  const baseDb = drizzle(pool, { schema });
  // Attach the raw pool so callers can shut it down cleanly. drizzle's own
  // accessor name has shifted across versions ($client vs $pool); we expose
  // our own stable handle here so the rest of the code is insulated.
  const db = baseDb as unknown as Db;
  db.$pool = pool;
  return db;
}

export async function closeDb(db: Db): Promise<void> {
  await db.$pool.end();
}

export { schema };
