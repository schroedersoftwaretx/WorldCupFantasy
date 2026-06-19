/**
 * GET  /api/leagues/[leagueId]/draft/queue  - the viewer's pick queue.
 * POST /api/leagues/[leagueId]/draft/queue   - mutate it. Body:
 *     { action: "add",     playerId }
 *     { action: "remove",  playerId }
 *     { action: "reorder", order: number[] }   // player ids, priority order
 *
 * Thin adapter over `src/data/draft/queue.ts`. Each manager owns only their own
 * team's queue; the route resolves the viewer's team in the league.
 */
import {
  addToQueue,
  getQueue,
  removeFromQueue,
  reorderQueue,
  type QueueEntry,
} from "@/data/draft/queue";
import { handle, HttpError, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { findDraftRoom, getManagerTeam } from "@/web/draft-view";
import { getMembershipRole } from "@/web/queries";
import type { Db } from "@/data/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolveContext(
  request: Request,
  leagueIdRaw: string,
): Promise<{ db: Db; leagueId: number; draftRoomId: number; teamId: number }> {
  const { manager } = await requireUserForRoute(request);
  const leagueId = parseId(leagueIdRaw, "leagueId");
  const db = getDb();
  const role = await getMembershipRole(db, leagueId, manager.id);
  if (!role) {
    throw new HttpError(`league ${leagueId} not found`, "LEAGUE_NOT_FOUND", 404);
  }
  const team = await getManagerTeam(db, leagueId, manager.id);
  if (!team) {
    throw new HttpError("you have no team in this league", "NO_TEAM", 404);
  }
  const room = await findDraftRoom(db, leagueId);
  if (!room) {
    throw new HttpError("this league has no draft room", "NO_DRAFT_ROOM", 404);
  }
  return { db, leagueId, draftRoomId: room.id, teamId: team.id };
}

export function GET(
  request: Request,
  ctx: { params: Promise<{ leagueId: string }> },
): Promise<Response> {
  return handle(async (): Promise<{ queue: QueueEntry[] }> => {
    const { leagueId } = await ctx.params;
    const c = await resolveContext(request, leagueId);
    return { queue: await getQueue(c.db, c.draftRoomId, c.teamId, c.leagueId) };
  });
}

export function POST(
  request: Request,
  ctx: { params: Promise<{ leagueId: string }> },
): Promise<Response> {
  return handle(async (): Promise<{ queue: QueueEntry[] }> => {
    const { leagueId } = await ctx.params;
    const c = await resolveContext(request, leagueId);
    const body = (await request.json()) as {
      action?: unknown;
      playerId?: unknown;
      order?: unknown;
    };

    if (body.action === "add" || body.action === "remove") {
      if (typeof body.playerId !== "number" || !Number.isInteger(body.playerId)) {
        throw new HttpError("playerId must be an integer", "INVALID_QUEUE", 400);
      }
      const fn = body.action === "add" ? addToQueue : removeFromQueue;
      return { queue: await fn(c.db, c.draftRoomId, c.teamId, body.playerId, c.leagueId) };
    }

    if (body.action === "reorder") {
      if (
        !Array.isArray(body.order) ||
        !body.order.every((x) => typeof x === "number" && Number.isInteger(x))
      ) {
        throw new HttpError("order must be an array of integers", "INVALID_QUEUE", 400);
      }
      return {
        queue: await reorderQueue(
          c.db,
          c.draftRoomId,
          c.teamId,
          body.order as number[],
          c.leagueId,
        ),
      };
    }

    throw new HttpError("unknown queue action", "INVALID_QUEUE", 400);
  });
}
