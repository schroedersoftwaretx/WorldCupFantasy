/**
 * POST /api/leagues/[leagueId]/chat/[messageId]/reactions  Body: { emoji }
 *
 * Toggle one emoji reaction on a message. Returns { reacted } - true when
 * the reaction is now present, false when the toggle removed it.
 */
import { z } from "zod";

import { toggleReaction } from "@/data/social/chat";
import { handle, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { parseBody } from "@/web/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ReactSchema = z.object({
  emoji: z.string().min(1).max(16),
});

export function POST(
  request: Request,
  ctx: { params: Promise<{ leagueId: string; messageId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { manager } = await requireUserForRoute(request);
    const { leagueId, messageId } = await ctx.params;
    const { emoji } = await parseBody(request, ReactSchema);
    const reacted = await toggleReaction(getDb(), {
      leagueId: parseId(leagueId, "leagueId"),
      messageId: parseId(messageId, "messageId"),
      managerId: manager.id,
      emoji,
    });
    return { reacted };
  });
}
