/**
 * League + manager services (Phase 3).
 *
 * Pure service functions over the DB:
 *
 *   createManager   Upsert a manager by Firebase UID.
 *   createLeague    Create a league + its OWNER membership + the owner's
 *                   fantasy_team, all in one transaction.
 *   inviteManager   Mint a token-based league_invite.
 *   acceptInvite    Redeem a token: add membership + fantasy_team, mark the
 *                   invite ACCEPTED. Enforces max_managers.
 *   revokeInvite    Mark a PENDING invite REVOKED.
 *
 * No HTTP, no auth middleware - the manager identity (Firebase UID) is
 * supplied by the caller. JWT verification lands with the API layer.
 */

import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import {
  fantasyTeam,
  league,
  leagueInvite,
  leagueMembership,
  manager,
  type FantasyTeamRow,
  type LeagueInviteRow,
  type LeagueMembershipRow,
  type LeagueRow,
  type ManagerRow,
} from "../db/schema.js";
import { DEFAULT_RULESET, type ScoringRuleset } from "../scoring/ruleset.js";
import { LeagueError } from "./errors.js";

const MIN_MANAGERS = 2;
const MAX_MANAGERS = 24;
const DEFAULT_INVITE_TTL_HOURS = 24 * 7;

// --- manager ----------------------------------------------------------------

export interface CreateManagerInput {
  firebaseUid: string;
  displayName: string;
  email: string;
}

/**
 * Upsert a manager by Firebase UID. If the UID already exists the
 * display name / email are refreshed; otherwise a new row is inserted.
 * Idempotent - calling twice with the same input is a no-op after the first.
 */
export async function createManager(
  db: Db,
  input: CreateManagerInput,
): Promise<ManagerRow> {
  const existing = await db
    .select()
    .from(manager)
    .where(eq(manager.firebaseUid, input.firebaseUid));
  const current = existing[0];

  if (current) {
    if (
      current.displayName === input.displayName &&
      current.email === input.email
    ) {
      return current;
    }
    const [updated] = await db
      .update(manager)
      .set({
        displayName: input.displayName,
        email: input.email,
        updatedAt: new Date(),
      })
      .where(eq(manager.id, current.id))
      .returning();
    if (!updated) throw new LeagueError("manager update failed", "MANAGER_UPDATE_FAILED");
    return updated;
  }

  const [created] = await db
    .insert(manager)
    .values({
      firebaseUid: input.firebaseUid,
      displayName: input.displayName,
      email: input.email,
    })
    .returning();
  if (!created) throw new LeagueError("manager insert failed", "MANAGER_INSERT_FAILED");
  return created;
}

// --- league -----------------------------------------------------------------

export interface CreateLeagueInput {
  ownerManagerId: number;
  name: string;
  /** 2..24; defaults to 24. */
  maxManagers?: number;
  /** Defaults to DEFAULT_RULESET. */
  scoringRuleset?: ScoringRuleset;
  /** Owner's team name; defaults to "<displayName>'s Team". */
  ownerTeamName?: string;
}

export interface CreateLeagueResult {
  league: LeagueRow;
  ownerMembership: LeagueMembershipRow;
  ownerTeam: FantasyTeamRow;
}

/**
 * Create a league. In one transaction this also creates the owner's
 * membership (role OWNER) and the owner's fantasy_team, so a freshly
 * created league is immediately in a consistent, playable state.
 */
export async function createLeague(
  db: Db,
  input: CreateLeagueInput,
): Promise<CreateLeagueResult> {
  const maxManagers = input.maxManagers ?? MAX_MANAGERS;
  if (
    !Number.isInteger(maxManagers) ||
    maxManagers < MIN_MANAGERS ||
    maxManagers > MAX_MANAGERS
  ) {
    throw new LeagueError(
      `maxManagers must be an integer in [${MIN_MANAGERS}, ${MAX_MANAGERS}]`,
      "INVALID_MAX_MANAGERS",
    );
  }
  if (input.name.trim().length === 0) {
    throw new LeagueError("league name must not be empty", "INVALID_LEAGUE_NAME");
  }

  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select()
      .from(manager)
      .where(eq(manager.id, input.ownerManagerId));
    if (!owner) {
      throw new LeagueError(
        `manager ${input.ownerManagerId} does not exist`,
        "MANAGER_NOT_FOUND",
      );
    }

    const ruleset = input.scoringRuleset ?? DEFAULT_RULESET;
    const [createdLeague] = await tx
      .insert(league)
      .values({
        name: input.name.trim(),
        createdByManagerId: owner.id,
        scoringRuleset: ruleset,
        maxManagers,
      })
      .returning();
    if (!createdLeague) throw new LeagueError("league insert failed", "LEAGUE_INSERT_FAILED");

    const [ownerMembership] = await tx
      .insert(leagueMembership)
      .values({
        leagueId: createdLeague.id,
        managerId: owner.id,
        role: "OWNER",
      })
      .returning();
    if (!ownerMembership) {
      throw new LeagueError("membership insert failed", "MEMBERSHIP_INSERT_FAILED");
    }

    const [ownerTeam] = await tx
      .insert(fantasyTeam)
      .values({
        leagueId: createdLeague.id,
        managerId: owner.id,
        name: input.ownerTeamName?.trim() || `${owner.displayName}'s Team`,
      })
      .returning();
    if (!ownerTeam) throw new LeagueError("team insert failed", "TEAM_INSERT_FAILED");

    return { league: createdLeague, ownerMembership, ownerTeam };
  });
}

// --- invites ----------------------------------------------------------------

export interface InviteManagerInput {
  leagueId: number;
  /** Optional: restrict the invite to a specific email address. */
  email?: string;
  /** Invite lifetime; defaults to 7 days. */
  ttlHours?: number;
}

/**
 * Mint a token-based invite for a league. The returned row carries the
 * token; share it with the prospective manager, who redeems it via
 * acceptInvite().
 */
export async function inviteManager(
  db: Db,
  input: InviteManagerInput,
): Promise<LeagueInviteRow> {
  const [lg] = await db.select().from(league).where(eq(league.id, input.leagueId));
  if (!lg) {
    throw new LeagueError(`league ${input.leagueId} does not exist`, "LEAGUE_NOT_FOUND");
  }

  const ttlHours = input.ttlHours ?? DEFAULT_INVITE_TTL_HOURS;
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  const token = randomBytes(24).toString("base64url");

  const [invite] = await db
    .insert(leagueInvite)
    .values({
      leagueId: input.leagueId,
      token,
      email: input.email ?? null,
      expiresAt,
    })
    .returning();
  if (!invite) throw new LeagueError("invite insert failed", "INVITE_INSERT_FAILED");
  return invite;
}

export interface AcceptInviteInput {
  token: string;
  managerId: number;
  /** Joining manager's team name; defaults to "<displayName>'s Team". */
  teamName?: string;
}

export interface AcceptInviteResult {
  league: LeagueRow;
  membership: LeagueMembershipRow;
  team: FantasyTeamRow;
}

/**
 * Redeem an invite token. Validates that the invite is PENDING, not
 * expired, and (if it targets a specific email) intended for this manager;
 * enforces the league's max_managers; then adds membership + fantasy_team
 * and marks the invite ACCEPTED - all transactionally.
 */
export async function acceptInvite(
  db: Db,
  input: AcceptInviteInput,
): Promise<AcceptInviteResult> {
  return db.transaction(async (tx) => {
    const [invite] = await tx
      .select()
      .from(leagueInvite)
      .where(eq(leagueInvite.token, input.token));
    if (!invite) {
      throw new LeagueError("invite token not found", "INVITE_NOT_FOUND");
    }
    if (invite.status !== "PENDING") {
      throw new LeagueError(
        `invite is ${invite.status.toLowerCase()}, not pending`,
        "INVITE_NOT_PENDING",
      );
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
      throw new LeagueError("invite has expired", "INVITE_EXPIRED");
    }

    const [joiningManager] = await tx
      .select()
      .from(manager)
      .where(eq(manager.id, input.managerId));
    if (!joiningManager) {
      throw new LeagueError(
        `manager ${input.managerId} does not exist`,
        "MANAGER_NOT_FOUND",
      );
    }

    // Targeted invite: the joining manager's email must match.
    if (
      invite.email &&
      invite.email.trim().toLowerCase() !== joiningManager.email.trim().toLowerCase()
    ) {
      throw new LeagueError(
        "this invite is addressed to a different email",
        "INVITE_EMAIL_MISMATCH",
      );
    }

    const [lg] = await tx.select().from(league).where(eq(league.id, invite.leagueId));
    if (!lg) {
      throw new LeagueError("league for this invite no longer exists", "LEAGUE_NOT_FOUND");
    }

    // Already a member? Idempotency guard - reject rather than duplicate.
    const existingMembership = await tx
      .select()
      .from(leagueMembership)
      .where(
        and(
          eq(leagueMembership.leagueId, lg.id),
          eq(leagueMembership.managerId, joiningManager.id),
        ),
      );
    if (existingMembership[0]) {
      throw new LeagueError(
        "manager is already a member of this league",
        "ALREADY_A_MEMBER",
      );
    }

    // Enforce max_managers.
    const members = await tx
      .select()
      .from(leagueMembership)
      .where(eq(leagueMembership.leagueId, lg.id));
    if (members.length >= lg.maxManagers) {
      throw new LeagueError(
        `league is full (${lg.maxManagers} managers)`,
        "LEAGUE_FULL",
      );
    }

    const [membership] = await tx
      .insert(leagueMembership)
      .values({
        leagueId: lg.id,
        managerId: joiningManager.id,
        role: "MEMBER",
      })
      .returning();
    if (!membership) {
      throw new LeagueError("membership insert failed", "MEMBERSHIP_INSERT_FAILED");
    }

    const [team] = await tx
      .insert(fantasyTeam)
      .values({
        leagueId: lg.id,
        managerId: joiningManager.id,
        name: input.teamName?.trim() || `${joiningManager.displayName}'s Team`,
      })
      .returning();
    if (!team) throw new LeagueError("team insert failed", "TEAM_INSERT_FAILED");

    await tx
      .update(leagueInvite)
      .set({
        status: "ACCEPTED",
        acceptedByManagerId: joiningManager.id,
        acceptedAt: new Date(),
      })
      .where(eq(leagueInvite.id, invite.id));

    return { league: lg, membership, team };
  });
}

/**
 * Revoke a still-PENDING invite so its token can no longer be redeemed.
 */
export async function revokeInvite(db: Db, inviteId: number): Promise<LeagueInviteRow> {
  const [invite] = await db
    .select()
    .from(leagueInvite)
    .where(eq(leagueInvite.id, inviteId));
  if (!invite) {
    throw new LeagueError(`invite ${inviteId} not found`, "INVITE_NOT_FOUND");
  }
  if (invite.status !== "PENDING") {
    throw new LeagueError(
      `invite is ${invite.status.toLowerCase()}, cannot revoke`,
      "INVITE_NOT_PENDING",
    );
  }
  const [updated] = await db
    .update(leagueInvite)
    .set({ status: "REVOKED" })
    .where(eq(leagueInvite.id, inviteId))
    .returning();
  if (!updated) throw new LeagueError("invite revoke failed", "INVITE_REVOKE_FAILED");
  return updated;
}
