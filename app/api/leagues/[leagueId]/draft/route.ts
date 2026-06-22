/**
 * GET  /api/leagues/[leagueId]/draft  - the draft-room state (the poll target).
 * POST /api/leagues/[leagueId]/draft  - create the draft room (owner only).
 *
 * Both are auth- and membership-gated.
 */
import { z } from "zod";

import { createDraftRoom } from "@/data/draft/service";
import { handle, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getDraftRoomView } from "@/web/draft-view";
import { getMembershipRole } from "@/web/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The create-draft body is entirely optional (an absent or non-object body is
// tolerated and means "use defaults"). `.catch` keeps that lenience while a
// non-numeric pickTimerHours is ignored, exactly as before.
const CreateDraftSchema = z
  .object({ pickTimerHours: z.number().optional().catch(undefined) })
  .catch({ pickTimerHours: undefined });

export function GET(
  request: Request,
  ctx: { params: Promise<{ leagueId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { manager } = await requireUserForRoute(request);
    const { leagueId } = await ctx.params;
    const id = parseId(leagueId, "leagueId");
    const db = getDb();
    const role = await getMembershipRole(db, id, manager.id);
    if (!role) {
      throw new HttpError(`league ${id} not found`, "LEAGUE_NOT_FOUND", 404);
    }
    return getDraftRoomView(db, id, manager.id);
  });
}

export function POST(
  request: Request,
  ctx: { params: Promise<{ leagueId: string }> },
): Promise<Response> {
  return handle(async () => {
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
        "only the league owner can create the draft",
        "FORBIDDEN",
        403,
      );
    }

    // The body (an optional pick timer) may be absent entirely.
    const raw: unknown = await request.json().catch(() => ({}));
    const { pickTimerHours } = CreateDraftSchema.parse(raw);
    const input: { leagueId: number; pickTimerHours?: number } = {
      leagueId: id,
    };
    if (typeof pickTimerHours === "number") {
      input.pickTimerHours = pickTimerHours;
    }

    const room = await createDraftRoom(db, input);
    return { draftRoomId: room.id };
  });
}
