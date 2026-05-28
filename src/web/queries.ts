/**
 * Read-side queries for the web app.
 *
 * These are presentation-layer aggregations (a manager's leagues, a league's
 * members, an invite lookup) - simple SELECTs that join a few tables for
 * display. They deliberately live here rather than in `src/data`: the data
 * layer holds game logic and writes, while these are view shapes specific to
 * the web UI. No writes happen here.
 */
import { and, eq, inArray } from "drizzle-orm";

import type { Db } from "../data/db/client.js";
import {
  fantasyTeam,
  league,
  leagueInvite,
  leagueMembership,
  manager,
  type LeagueRow,
} from "../data/db/schema.js";
import type {
  InviteLookup,
  LeagueDetail,
  LeagueMemberInfo,
  LeagueSummary,
} from "./api-types.js";

/** Shape one league row + a member count into a summary. */
function toSummary(l: LeagueRow, memberCount: number): LeagueSummary {
  return {
    id: l.id,
    name: l.name,
    status: l.status,
    maxManagers: l.maxManagers,
    rosterSize: l.rosterSize,
    memberCount,
    createdAt: l.createdAt.toISOString(),
  };
}

/** List the leagues the given manager belongs to, each with its member count. */
export async function listLeaguesForManager(
  db: Db,
  managerId: number,
): Promise<LeagueSummary[]> {
  const myMemberships = await db
    .select()
    .from(leagueMembership)
    .where(eq(leagueMembership.managerId, managerId));
  const leagueIds = myMemberships.map((m) => m.leagueId);
  if (leagueIds.length === 0) return [];

  const leagues = await db
    .select()
    .from(league)
    .where(inArray(league.id, leagueIds));

  // Member counts across all of those leagues.
  const allMemberships = await db
    .select()
    .from(leagueMembership)
    .where(inArray(leagueMembership.leagueId, leagueIds));
  const memberCount = new Map<number, number>();
  for (const m of allMemberships) {
    memberCount.set(m.leagueId, (memberCount.get(m.leagueId) ?? 0) + 1);
  }

  return leagues
    .map((l) => toSummary(l, memberCount.get(l.id) ?? 0))
    .sort((a, b) => a.id - b.id);
}

/**
 * The given manager's role in a league ("OWNER" / "MEMBER"), or null if they
 * are not a member. Used to gate league pages and owner-only actions.
 */
export async function getMembershipRole(
  db: Db,
  leagueId: number,
  managerId: number,
): Promise<string | null> {
  const [m] = await db
    .select()
    .from(leagueMembership)
    .where(
      and(
        eq(leagueMembership.leagueId, leagueId),
        eq(leagueMembership.managerId, managerId),
      ),
    );
  return m?.role ?? null;
}

/** One league with its members, or `null` if the league does not exist. */
export async function getLeagueDetail(
  db: Db,
  leagueId: number,
): Promise<LeagueDetail | null> {
  const [lg] = await db.select().from(league).where(eq(league.id, leagueId));
  if (!lg) return null;

  const memberships = await db
    .select()
    .from(leagueMembership)
    .where(eq(leagueMembership.leagueId, leagueId));
  const teams = await db
    .select()
    .from(fantasyTeam)
    .where(eq(fantasyTeam.leagueId, leagueId));

  const managerIds = memberships.map((m) => m.managerId);
  const managers =
    managerIds.length > 0
      ? await db.select().from(manager).where(inArray(manager.id, managerIds))
      : [];

  const managerById = new Map(managers.map((m) => [m.id, m]));
  const teamByManager = new Map(teams.map((t) => [t.managerId, t]));

  const members: LeagueMemberInfo[] = memberships.map((m) => {
    const mgr = managerById.get(m.managerId);
    const team = teamByManager.get(m.managerId);
    return {
      managerId: m.managerId,
      displayName: mgr?.displayName ?? `manager #${m.managerId}`,
      role: m.role,
      teamId: team?.id ?? null,
      teamName: team?.name ?? null,
    };
  });

  return {
    ...toSummary(lg, members.length),
    members,
  };
}

/**
 * Look up a league invite by its token, joined to its league - enough to
 * render the join page. Returns null if the token does not exist.
 */
export async function getInviteByToken(
  db: Db,
  token: string,
): Promise<InviteLookup | null> {
  const [inv] = await db
    .select()
    .from(leagueInvite)
    .where(eq(leagueInvite.token, token));
  if (!inv) return null;

  const [lg] = await db.select().from(league).where(eq(league.id, inv.leagueId));
  if (!lg) return null;

  return {
    token: inv.token,
    leagueId: inv.leagueId,
    leagueName: lg.name,
    status: inv.status,
    expiresAt: inv.expiresAt.toISOString(),
  };
}
