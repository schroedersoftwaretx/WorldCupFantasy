/**
 * PATCH  /api/leagues/[leagueId]/chat/[messageId]  Body: { body }
 *        Edit your own message.
 * DELETE /api/leagues/[leagueId]/chat/[messageId]
 *        Soft-delete (author, or league owner for moderation).
 */
import { z } from "zod";

import { deleteMessage, editMessage } from "@/data/social/chat";
import { handle, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { parseBody } from "@/web/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EditSchema = z.object({
  body: z.string().min(1).max(2000),
});

export function PATCH(
  request: Request,
  ctx: { params: Promise<{ leagueId: string; messageId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { manager } = await requireUserForRoute(request);
    const { leagueId, messageId } = await ctx.params;
    const { body } = await parseBody(request, EditSchema);
    return editMessage(getDb(), {
      leagueId: parseId(leagueId, "leagueId"),
      messageId: parseId(messageId, "messageId"),
      managerId: manager.id,
      body,
    });
  });
}

export function DELETE(
  request: Request,
  ctx: { params: Promise<{ leagueId: string; messageId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { manager } = await requireUserForRoute(request);
    const { leagueId, messageId } = await ctx.params;
    await deleteMessage(getDb(), {
      leagueId: parseId(leagueId, "leagueId"),
      messageId: parseId(messageId, "messageId"),
      managerId: manager.id,
    });
    return { deleted: true };
  });
}
