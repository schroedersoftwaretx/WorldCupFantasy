/**
 * GET  /api/leagues  - list the signed-in manager's leagues.
 * POST /api/leagues  - create a league; the caller becomes its owner.
 *
 * Both are auth-gated (W2). The list is scoped to the caller's memberships
 * (W3) - there is no "all leagues" view.
 */
import { createLeague } from "@/data/league/service";
import { handle, HttpError } from "@/web/api";
import type { LeagueCreatedData } from "@/web/api-types";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { listLeaguesForManager } from "@/web/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const { manager } = await requireUserForRoute(request);
    return listLeaguesForManager(getDb(), manager.id);
  });
}

export function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { manager } = await requireUserForRoute(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new HttpError("request body must be JSON", "BAD_REQUEST", 400);
    }
    const { name, maxManagers } = body as {
      name?: unknown;
      maxManagers?: unknown;
    };
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new HttpError("league name is required", "BAD_REQUEST", 400);
    }

    // Build the input conditionally - exactOptionalPropertyTypes forbids
    // assigning an explicit `undefined` to the optional maxManagers.
    const input: {
      ownerManagerId: number;
      name: string;
      maxManagers?: number;
    } = { ownerManagerId: manager.id, name: name.trim() };
    if (typeof maxManagers === "number") {
      input.maxManagers = maxManagers;
    }

    const result = await createLeague(getDb(), input);
    const data: LeagueCreatedData = {
      leagueId: result.league.id,
      name: result.league.name,
    };
    return data;
  });
}
