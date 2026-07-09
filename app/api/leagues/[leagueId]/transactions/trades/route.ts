/**
 * POST /api/leagues/[leagueId]/transactions/trades - propose a trade.
 * Body: { counterpartyTeamId, offerPlayerIds: [..], requestPlayerIds: [..] }
 */
import { z } from "zod";

import { proposeTrade } from "@/data/transactions/service";
import { handle, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { parseBody } from "@/web/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ProposeSchema = z.object({
  counterpartyTeamId: z.number().int().positive(),
  offerPlayerIds: z.array(z.number().int().positive()).min(1).max(5),
  requestPlayerIds: z.array(z.number().int().positive()).min(1).max(5),
});

export function POST(
  request: Request,
  ctx: { params: Promise<{ leagueId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { manager } = await requireUserForRoute(request);
    const { leagueId } = await ctx.params;
    const id = parseId(leagueId, "leagueId");
    const body = await parseBody(request, ProposeSchema);
    return proposeTrade(getDb(), {
      leagueId: id,
      managerId: manager.id,
      counterpartyTeamId: body.counterpartyTeamId,
      offerPlayerIds: body.offerPlayerIds,
      requestPlayerIds: body.requestPlayerIds,
    });
  });
}
