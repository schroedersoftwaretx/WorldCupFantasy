/**
 * GET  /api/leagues/[leagueId]/chat?before=<id>&limit=<n>
 *      Newest-first page of chat messages with reactions.
 * POST /api/leagues/[leagueId]/chat  Body: { body }
 *      Post a message (fans out burst-deduped notifications).
 *
 * Membership and the `chat` feature flag are enforced by the service.
 */
import { z } from "zod";

import { listMessages, postMessage } from "@/data/social/chat";
import { handle, parseId } from "@/web/api";
import { requireUserForRoute } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { parseBody, parseQuery } from "@/web/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ListQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const PostSchema = z.object({
  body: z.string().min(1).max(2000),
});

export function GET(
  request: Request,
  ctx: { params: Promise<{ leagueId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { manager } = await requireUserForRoute(request);
    const { leagueId } = await ctx.params;
    const id = parseId(leagueId, "leagueId");
    const q = parseQuery(new URL(request.url).searchParams, ListQuerySchema);
    return listMessages(getDb(), {
      leagueId: id,
      managerId: manager.id,
      ...(q.before !== undefined ? { beforeId: q.before } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    });
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
    const { body } = await parseBody(request, PostSchema);
    return postMessage(getDb(), { leagueId: id, managerId: manager.id, body });
  });
}
