/**
 * GET  /api/leagues/[leagueId]/flags  - any member reads the league's flags.
 * PUT  /api/leagues/[leagueId]/flags  - OWNER toggles one flag.
 *
 * Thin adapter over `src/data/league/feature-flags.ts`. PUT body:
 *   { flag: FeatureFlag, enabled: boolean, config?: unknown }
 * Returns the full flag-state map after the change so the caller can re-render.
 */
import {
  getFlagStates,
  isFeatureFlag,
  setFlag,
  type FlagStateMap,
} from "@/data/league/feature-flags";
import { handle, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(
  request: Request,
  ctx: { params: Promise<{ leagueId: string }> },
): Promise<Response> {
  return handle(async (): Promise<{ flags: FlagStateMap }> => {
    const { manager } = await requireUserForRoute(request);
    const { leagueId } = await ctx.params;
    const id = parseId(leagueId, "leagueId");
    const db = getDb();

    const role = await getMembershipRole(db, id, manager.id);
    if (!role) {
      throw new HttpError(`league ${id} not found`, "LEAGUE_NOT_FOUND", 404);
    }
    return { flags: await getFlagStates(db, id) };
  });
}

export function PUT(
  request: Request,
  ctx: { params: Promise<{ leagueId: string }> },
): Promise<Response> {
  return handle(async (): Promise<{ flags: FlagStateMap }> => {
    const { manager } = await requireUserForRoute(request);
    const { leagueId } = await ctx.params;
    const id = parseId(leagueId, "leagueId");
    const db = getDb();

    const role = await getMembershipRole(db, id, manager.id);
    if (!role) {
      throw new HttpError(`league ${id} not found`, "LEAGUE_NOT_FOUND", 404);
    }
    if (role !== "OWNER") {
      throw new HttpError(
        "only the league owner can change features",
        "FORBIDDEN",
        403,
      );
    }

    const body = (await request.json()) as {
      flag?: unknown;
      enabled?: unknown;
      config?: unknown;
    };
    if (typeof body.flag !== "string" || !isFeatureFlag(body.flag)) {
      throw new HttpError("unknown feature flag", "INVALID_FLAG", 400);
    }
    if (typeof body.enabled !== "boolean") {
      throw new HttpError("enabled must be a boolean", "INVALID_FLAG", 400);
    }

    await setFlag(db, id, body.flag, {
      enabled: body.enabled,
      ...(body.config !== undefined ? { config: body.config } : {}),
    });
    return { flags: await getFlagStates(db, id) };
  });
}
