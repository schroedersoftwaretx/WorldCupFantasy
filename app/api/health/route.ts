/**
 * GET /api/health
 *
 * A liveness/readiness probe. Confirms the process is up, runs a `select 1`
 * to confirm the database is reachable, and reports whether the Firebase
 * Admin SDK has its service-account credentials - a quick way to diagnose
 * sign-in problems without digging through server logs.
 *
 * Returns 200 when the database answers, 503 when it does not.
 */
import { sql } from "drizzle-orm";

import { err, ok } from "@/web/api";
import type { HealthData } from "@/web/api-types";
import { getDb } from "@/web/db";
import { isAdminConfigured } from "@/web/firebase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let dbUp = false;
  try {
    await getDb().execute(sql`select 1`);
    dbUp = true;
  } catch (e) {
    console.error("[health] database check failed:", e);
  }

  const firebaseAdmin = isAdminConfigured() ? "configured" : "unconfigured";

  if (!dbUp) {
    return err(
      `database unreachable (firebaseAdmin: ${firebaseAdmin})`,
      "DB_DOWN",
      503,
    );
  }

  const data: HealthData = {
    status: "ok",
    db: "up",
    firebaseAdmin,
    time: new Date().toISOString(),
  };
  return ok(data);
}
