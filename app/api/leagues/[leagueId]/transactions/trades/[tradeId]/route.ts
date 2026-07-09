/**
 * POST /api/leagues/[leagueId]/transactions/trades/[tradeId] - act on a
 * proposed trade. Body: { action: "ACCEPT" | "REJECT" | "CANCEL" | "VETO" }
 * ACCEPT/REJECT: counterparty owner. CANCEL: proposer. VETO: league owner.
 */
import { z } from "zod";

import { respondTrade } from "@/data/transactions/service";
import { handle, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { parseBody } from "@/web/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ActionSchema = z.object({
  action: z.enum(["ACCEPT", "REJECT", "CANCEL", "VETO"]),
});

export function POST(
  request: Request,
  ctx: { params: Promise<{ leagueId: string; tradeId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { manager } = await requireUserForRoute(request);
    const { leagueId, tradeId } = await ctx.params;
    const body = await parseBody(request, ActionSchema);
    return respondTrade(getDb(), {
      leagueId: parseId(leagueId, "leagueId"),
      managerId: manager.id,
      tradeId: parseId(tradeId, "tradeId"),
      action: body.action,
    });
  });
}
