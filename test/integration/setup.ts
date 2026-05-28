/**
 * Testcontainers-backed Postgres for integration tests.
 *
 * One ephemeral container per test file (via `setupContainer`); it boots in
 * `beforeAll`, migrations are applied, and the container is torn down in
 * `afterAll`. Each test gets a freshly truncated DB via `resetDb()` so
 * cross-test state doesn't leak.
 *
 * Requires Docker on the test runner host. With Docker absent the
 * container start step throws, surfacing the missing prerequisite up front.
 *
 * Escape hatch: if INTEGRATION_DATABASE_URL is set, the suite skips the
 * container start and runs against that URL instead. This is what lets CI
 * sandboxes without Docker provision their own Postgres externally.
 */
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll } from "vitest";

import { closeDb, createDb, type Db } from "../../src/data/db/client.js";
import { runMigrations } from "../../src/migrate.js";

export interface IntegrationContext {
  readonly db: Db;
  readonly connectionString: string;
  resetDb(): Promise<void>;
}

const PG_USER = "test";
const PG_PASS = "test";
const PG_DB = "worldcup_fantasy_test";
const PG_PORT = 5432;

export function setupContainer(): { ctx: IntegrationContext } {
  let container: StartedTestContainer | null = null;
  let db: Db | null = null;
  let connectionString = "";

  beforeAll(async () => {
    const external = process.env["INTEGRATION_DATABASE_URL"];
    if (external) {
      connectionString = external;
    } else {
      container = await new GenericContainer("postgres:16-alpine")
        .withEnvironment({
          POSTGRES_USER: PG_USER,
          POSTGRES_PASSWORD: PG_PASS,
          POSTGRES_DB: PG_DB,
        })
        .withExposedPorts(PG_PORT)
        .withWaitStrategy(
          Wait.forLogMessage(/database system is ready to accept connections/g, 2),
        )
        .withStartupTimeout(60_000)
        .start();

      const host = container.getHost();
      const port = container.getMappedPort(PG_PORT);
      connectionString = `postgres://${PG_USER}:${PG_PASS}@${host}:${port}/${PG_DB}`;
    }
    await runMigrations(connectionString);
    db = createDb({ connectionString, max: 4 });
  }, 120_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    if (container) await container.stop();
  }, 60_000);

  const ctx: IntegrationContext = {
    get db() {
      if (!db) throw new Error("integration db not initialised - beforeAll did not run");
      return db;
    },
    get connectionString() {
      return connectionString;
    },
    async resetDb() {
      if (!db) return;
      // TRUNCATE in FK-safe order; preserve schema + enums.
      await db.execute(
        sql`TRUNCATE TABLE stat_line, fixture, player, national_team RESTART IDENTITY CASCADE`,
      );
    },
  };

  return { ctx };
}
