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
 * sandboxes without Docker provision their own Postgres externally. A safety
 * guard (assertSafeIntegrationDb) refuses to run against the production DB.
 */
import { readFileSync } from "node:fs";

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
      assertSafeIntegrationDb(external);
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

/**
 * Safety guard. The integration suite runs migrations and `TRUNCATE ... CASCADE`,
 * so it must NEVER point at the production database. We refuse to run against an
 * external INTEGRATION_DATABASE_URL that resolves to the same host+database as
 * DATABASE_URL (read from the environment or the local `.env` file).
 *
 * The default path uses a disposable Testcontainers Postgres: with Docker
 * running, no external URL is used and this guard is a no-op. Set
 * INTEGRATION_DB_FORCE=1 to override deliberately (e.g. a CI-provisioned
 * throwaway DB you trust).
 */
function assertSafeIntegrationDb(url: string): void {
  if (process.env["INTEGRATION_DB_FORCE"] === "1") return;
  const target = hostAndDb(url);
  if (!target) return;
  const prodCandidates = [
    process.env["DATABASE_URL"],
    readEnvFileVar("DATABASE_URL"),
  ];
  for (const cand of prodCandidates) {
    const prod = cand ? hostAndDb(cand) : null;
    if (prod && prod === target) {
      throw new Error(
        "Refusing to run integration tests: INTEGRATION_DATABASE_URL points at the " +
          "same database as DATABASE_URL (" +
          target +
          "). These tests TRUNCATE tables and would destroy that data. Point " +
          "INTEGRATION_DATABASE_URL at a throwaway DB, or run with Docker so a " +
          "disposable container is used. Set INTEGRATION_DB_FORCE=1 only if you are " +
          "certain the target is safe to wipe.",
      );
    }
  }
}

/** Normalize a Postgres URL to a comparable "host/db" key, or null if unparseable. */
function hostAndDb(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.toLowerCase();
  } catch {
    return null;
  }
}

/** Best-effort read of a single var from the project-root `.env` (CI may have none). */
function readEnvFileVar(name: string): string | undefined {
  try {
    const raw = readFileSync(new URL("../../.env", import.meta.url), "utf8");
    const re = new RegExp("^\\s*" + name + "\\s*=\\s*\"?([^\"\\n\\r]+)", "m");
    const m = raw.match(re);
    return m && m[1] ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}
