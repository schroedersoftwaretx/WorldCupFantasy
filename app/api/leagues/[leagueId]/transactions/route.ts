/**
 * GET  /api/leagues/[leagueId]/transactions - the transactions hub: free
 *      agents (with waiver windows), your roster/claims, league trades, and
 *      the recent movement ledger.
 * POST /api/leagues/[leagueId]/transactions - execute a direct free-agent
 *      add and/or drop. Body: { addPlayerId?, dropPlayerId? }
 *
 * Flag/membership/roster rules enforced by the transactions service.
 */
import { z } from "zod";

import {
  addDropPlayers,
  getTransactionHub,
} from "@/data/transactions/service";
import { handle, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { parseBody } from "@/web/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AddDropSchema = z
  .object({
    addPlayerId: z.number().int().positive().optional(),
    dropPlayerId: z.number().int().positive().optional(),
  })
  .refine((b) => b.addPlayerId !== undefined || b.dropPlayerId !== undefined, {
    message: "provide addPlayerId and/or dropPlayerId",
  });

export function GET(
  request: Request,
  ctx: { params: Promise<{ leagueId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { manager } = await requireUserForRoute(request);
    const { leagueId } = await ctx.params;
    const id = parseId(leagueId, "leagueId");
    return getTransactionHub(getDb(), id, manager.id);
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
    const body = await parseBody(request, AddDropSchema);
    return addDropPlayers(getDb(), {
      leagueId: id,
      managerId: manager.id,
      ...(body.addPlayerId !== undefined ? { addPlayerId: body.addPlayerId } : {}),
      ...(body.dropPlayerId !== undefined ? { dropPlayerId: body.dropPlayerId } : {}),
    });
  });
}
