/**
 * GET  /api/leagues  - list the signed-in manager's leagues.
 * POST /api/leagues  - create a league; the caller becomes its owner.
 *
 * Both are auth-gated (W2). The list is scoped to the caller's memberships
 * (W3) - there is no "all leagues" view.
 */
import { z } from "zod";

import { createLeague } from "@/data/league/service";
import { handle } from "@/web/api";
import type { LeagueCreatedData } from "@/web/api-types";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { listLeaguesForManager } from "@/web/queries";
import { parseBody } from "@/web/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST body. `name` is required and non-blank. `maxManagers` is optional; a
 * non-numeric value is tolerated (ignored) exactly as the previous hand-rolled
 * parser did, via `.catch(undefined)`.
 */
const CreateLeagueSchema = z.object({
  name: z.string().refine((v) => v.trim().length > 0, "league name is required"),
  maxManagers: z.number().optional().catch(undefined),
});

export function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const { manager } = await requireUserForRoute(request);
    return listLeaguesForManager(getDb(), manager.id);
  });
}

export function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { manager } = await requireUserForRoute(request);

    const body = await parseBody(request, CreateLeagueSchema);

    // Build the input conditionally - exactOptionalPropertyTypes forbids
    // assigning an explicit `undefined` to the optional maxManagers.
    const input: {
      ownerManagerId: number;
      name: string;
      maxManagers?: number;
    } = { ownerManagerId: manager.id, name: body.name.trim() };
    if (typeof body.maxManagers === "number") {
      input.maxManagers = body.maxManagers;
    }

    const result = await createLeague(getDb(), input);
    const data: LeagueCreatedData = {
      leagueId: result.league.id,
      name: result.league.name,
    };
    return data;
  });
}
