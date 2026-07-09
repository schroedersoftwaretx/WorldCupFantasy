/**
 * POST  /api/leagues/[leagueId]/transactions/waivers - submit a waiver claim
 *       for a player on waivers. Body: { addPlayerId, dropPlayerId? }
 * PATCH /api/leagues/[leagueId]/transactions/waivers - cancel your pending
 *       claim. Body: { claimId }
 *
 * Claims are processed by the cron when their window expires, worst-placed
 * claimant first (reverse standings).
 */
import { z } from "zod";

import {
  cancelWaiverClaim,
  submitWaiverClaim,
} from "@/data/transactions/service";
import { handle, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { parseBody } from "@/web/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ClaimSchema = z.object({
  addPlayerId: z.number().int().positive(),
  dropPlayerId: z.number().int().positive().optional(),
});

const CancelSchema = z.object({
  claimId: z.number().int().positive(),
});

export function POST(
  request: Request,
  ctx: { params: Promise<{ leagueId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { manager } = await requireUserForRoute(request);
    const { leagueId } = await ctx.params;
    const id = parseId(leagueId, "leagueId");
    const body = await parseBody(request, ClaimSchema);
    return submitWaiverClaim(getDb(), {
      leagueId: id,
      managerId: manager.id,
      addPlayerId: body.addPlayerId,
      ...(body.dropPlayerId !== undefined ? { dropPlayerId: body.dropPlayerId } : {}),
    });
  });
}

export function PATCH(
  request: Request,
  ctx: { params: Promise<{ leagueId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { manager } = await requireUserForRoute(request);
    const { leagueId } = await ctx.params;
    const id = parseId(leagueId, "leagueId");
    const body = await parseBody(request, CancelSchema);
    return cancelWaiverClaim(getDb(), {
      leagueId: id,
      managerId: manager.id,
      claimId: body.claimId,
    });
  });
}
