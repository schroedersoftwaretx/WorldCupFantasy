import type { Config } from "drizzle-kit";

/**
 * drizzle-kit configuration.
 *
 * `schema` points at the Drizzle table definitions; `out` is where generated
 * SQL migrations live. Migrations are applied at runtime via `src/migrate.ts`,
 * which uses drizzle-orm's `migrate` helper against `DATABASE_URL`.
 */
export default {
  schema: "./src/data/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/worldcup_fantasy",
  },
  strict: true,
} satisfies Config;
