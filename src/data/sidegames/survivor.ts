/**
 * Survivor pool (phase-05 5.2), gated by the `survivor` feature flag.
 *
 * Each stage a manager picks one nation to WIN. Rules:
 *   - A nation is usable at most once per entry.
 *   - Picks lock at the stage's first kickoff.
 *   - A wrong pick costs a life. A group-stage draw is not a win. A level
 *     knockout match (penalties) is a WIN only if the nation appears in a
 *     later ingested round; until then the pick stays unresolved.
 *   - A MISSED pick (no pick for a stage that started after the entry
 *     joined) costs a life; resolution writes a NULL-team pick to record it.
 *   - At zero lives the entry is eliminated at that stage.
 *
 * Resolution is DERIVED from fixtures and runs in the post-stage cron step.
 * Idempotency: each pick's resolved_outcome is written exactly once; a
 * rerun only sees already-resolved picks and does nothing.
 *
 * Pure service: takes a Db and plain inputs; no HTTP/auth/env here.
 */
import { and, asc, eq, inArray } from "drizzle-orm";

import type { Db } from "../db/client.js";
import {
  fixture,
  league,
  leagueMembership,
  manager,
  nationalTeam,
  stageEnum,
  survivorEntry,
  survivorPick,
  type FixtureRow,
  type Stage,
  type SurvivorEntryRow,
  type SurvivorPickRow,
} from "../db/schema.js";
import { getFlagStates } from "../league/feature-flags.js";
import { recordEvent } from "../social/activity.js";

export class SurvivorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "SurvivorError";
  }
}

const STAGE_ORDER: readonly Stage[] = stageEnum.enumValues;

/** Flag + membership gate; returns configured lives (default 1). */
async function requireSurvivor(
  db: Db,
  leagueId: number,
  managerId: number,
): Promise<{ lives: number }> {
  const [lg] = await db.select().from(league).where(eq(league.id, leagueId));
  if (!lg) throw new SurvivorError(`league ${leagueId} does not exist`, "LEAGUE_NOT_FOUND");
  const flags = await getFlagStates(db, leagueId);
  if (!flags.survivor.enabled) {
    throw new SurvivorError(
      `league ${leagueId} does not have the survivor flag enabled`,
      "SURVIVOR_FLAG_DISABLED",
    );
  }
  const [membership] = await db
    .select()
    .from(leagueMembership)
    .where(
      and(
        eq(leagueMembership.leagueId, leagueId),
        eq(leagueMembership.managerId, managerId),
      ),
    );
  if (!membership) {
    throw new SurvivorError(
      `manager ${managerId} is not a member of league ${leagueId}`,
      "NOT_A_MEMBER",
    );
  }
  const config = flags.survivor.config as { lives?: number } | null;
  const lives =
    config && Number.isInteger(config.lives) && (config.lives as number) >= 1
      ? Math.min(config.lives as number, 5)
      : 1;
  return { lives };
}

/** Join the league's survivor pool (idempotent; lives from flag config). */
export async function joinSurvivor(
  db: Db,
  input: { leagueId: number; managerId: number; now?: Date },
): Promise<SurvivorEntryRow> {
  const { lives } = await requireSurvivor(db, input.leagueId, input.managerId);
  const [existing] = await db
    .select()
    .from(survivorEntry)
    .where(
      and(
        eq(survivorEntry.leagueId, input.leagueId),
        eq(survivorEntry.managerId, input.managerId),
      ),
    );
  if (existing) return existing;
  const [row] = await db
    .insert(survivorEntry)
    .values({
      leagueId: input.leagueId,
      managerId: input.managerId,
      livesRemaining: lives,
      createdAt: input.now ?? new Date(),
    })
    .returning();
  if (!row) throw new SurvivorError("entry insert failed", "ENTRY_INSERT_FAILED");
  return row;
}

/** First kickoff of a stage, or null before its fixtures are ingested. */
export async function stageFirstKickoff(db: Db, stage: Stage): Promise<Date | null> {
  const rows = await db
    .select({ kickoffUtc: fixture.kickoffUtc })
    .from(fixture)
    .where(eq(fixture.stage, stage))
    .orderBy(asc(fixture.kickoffUtc))
    .limit(1);
  return rows[0]?.kickoffUtc ?? null;
}

export interface SubmitSurvivorPickInput {
  leagueId: number;
  managerId: number;
  stage: Stage;
  nationalTeamId: number;
  now?: Date;
}

/** Submit/replace the pick for a stage (until it locks). */
export async function submitSurvivorPick(
  db: Db,
  input: SubmitSurvivorPickInput,
): Promise<SurvivorPickRow> {
  await requireSurvivor(db, input.leagueId, input.managerId);
  const [entry] = await db
    .select()
    .from(survivorEntry)
    .where(
      and(
        eq(survivorEntry.leagueId, input.leagueId),
        eq(survivorEntry.managerId, input.managerId),
      ),
    );
  if (!entry) {
    throw new SurvivorError("join the survivor pool first", "NOT_ENTERED");
  }
  if (entry.eliminatedAtStage !== null) {
    throw new SurvivorError("this entry has been eliminated", "ENTRY_ELIMINATED");
  }

  const now = input.now ?? new Date();
  const firstKickoff = await stageFirstKickoff(db, input.stage);
  if (firstKickoff !== null && now >= firstKickoff) {
    throw new SurvivorError(
      `picks for ${input.stage} locked at first kickoff (${firstKickoff.toISOString()})`,
      "PICK_LOCKED",
    );
  }

  const [team] = await db
    .select()
    .from(nationalTeam)
    .where(eq(nationalTeam.id, input.nationalTeamId));
  if (!team) {
    throw new SurvivorError(
      `national team ${input.nationalTeamId} does not exist`,
      "TEAM_NOT_FOUND",
    );
  }

  // A nation is usable once per entry (other stages' picks).
  const picks = await db
    .select()
    .from(survivorPick)
    .where(eq(survivorPick.survivorEntryId, entry.id));
  const reused = picks.find(
    (p) => p.nationalTeamId === input.nationalTeamId && p.stage !== input.stage,
  );
  if (reused) {
    throw new SurvivorError(
      `${team.name} was already used on ${reused.stage}`,
      "NATION_ALREADY_USED",
    );
  }
  const current = picks.find((p) => p.stage === input.stage);
  if (current?.resolvedOutcome) {
    throw new SurvivorError("that stage has already resolved", "PICK_RESOLVED");
  }

  const [row] = await db
    .insert(survivorPick)
    .values({
      survivorEntryId: entry.id,
      stage: input.stage,
      nationalTeamId: input.nationalTeamId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [survivorPick.survivorEntryId, survivorPick.stage],
      set: { nationalTeamId: input.nationalTeamId, updatedAt: now },
    })
    .returning();
  if (!row) throw new SurvivorError("pick upsert failed", "PICK_UPSERT_FAILED");
  return row;
}

/**
 * Decide a pick from a stage's fixtures - pure.
 *   "WIN"  - the nation won a fixture that stage on goals, or drew a
 *            knockout fixture and appears in a later ingested round.
 *   "LOSS" - played and did not win (or did not play that stage).
 *   null   - undecidable yet (level knockout, no later round ingested).
 */
export function decidePick(
  nationalTeamId: number,
  stage: Stage,
  fixtures: readonly Pick<
    FixtureRow,
    "stage" | "homeTeamId" | "awayTeamId" | "homeScore" | "awayScore" | "status"
  >[],
): "WIN" | "LOSS" | null {
  const mine = fixtures.filter(
    (f) =>
      f.stage === stage &&
      f.status === "FINISHED" &&
      (f.homeTeamId === nationalTeamId || f.awayTeamId === nationalTeamId),
  );
  if (mine.length === 0) return "LOSS"; // didn't play this stage
  let sawLevel = false;
  for (const f of mine) {
    const isHome = f.homeTeamId === nationalTeamId;
    const forGoals = (isHome ? f.homeScore : f.awayScore) ?? 0;
    const against = (isHome ? f.awayScore : f.homeScore) ?? 0;
    if (forGoals > against) return "WIN";
    if (forGoals === against) sawLevel = true;
  }
  if (!sawLevel) return "LOSS";
  const isGroup = stage.startsWith("GROUP");
  if (isGroup) return "LOSS"; // a draw is not a win
  // Level knockout (penalties): the winner surfaces in a later round.
  const stageIdx = STAGE_ORDER.indexOf(stage);
  const later = fixtures.filter((f) => STAGE_ORDER.indexOf(f.stage) > stageIdx);
  if (later.length === 0) return null; // not ingested yet - retry next cron
  return later.some(
    (f) => f.homeTeamId === nationalTeamId || f.awayTeamId === nationalTeamId,
  )
    ? "WIN"
    : "LOSS";
}

export interface SurvivorResolveSummary {
  leagueId: number;
  resolved: number;
  missedCharged: number;
  eliminated: number;
}

/**
 * Resolve every finished stage for one league: decide unresolved picks,
 * charge missed picks (stages that started after the entry joined),
 * decrement lives and mark eliminations. Idempotent - resolved picks are
 * never touched again.
 */
export async function resolveSurvivor(
  db: Db,
  leagueId: number,
): Promise<SurvivorResolveSummary> {
  const summary: SurvivorResolveSummary = {
    leagueId,
    resolved: 0,
    missedCharged: 0,
    eliminated: 0,
  };
  const entries = await db
    .select()
    .from(survivorEntry)
    .where(eq(survivorEntry.leagueId, leagueId));
  if (entries.length === 0) return summary;

  const fixtures = await db.select().from(fixture);
  // A stage is decided once it has fixtures and all of them are FINISHED.
  const finishedStages = STAGE_ORDER.filter((stage) => {
    const ofStage = fixtures.filter((f) => f.stage === stage);
    return ofStage.length > 0 && ofStage.every((f) => f.status === "FINISHED");
  });
  if (finishedStages.length === 0) return summary;

  const allPicks = await db
    .select()
    .from(survivorPick)
    .where(
      inArray(
        survivorPick.survivorEntryId,
        entries.map((e) => e.id),
      ),
    );

  for (const entry of entries) {
    if (entry.eliminatedAtStage !== null) continue;
    let lives = entry.livesRemaining;
    let eliminatedAt: Stage | null = null;

    for (const stage of finishedStages) {
      if (eliminatedAt) break;
      const pick = allPicks.find(
        (p) => p.survivorEntryId === entry.id && p.stage === stage,
      );
      if (pick?.resolvedOutcome) continue; // already settled

      let outcome: "WIN" | "LOSS" | null;
      if (pick && pick.nationalTeamId !== null) {
        outcome = decidePick(pick.nationalTeamId, stage, fixtures);
        if (outcome === null) continue; // pens undecidable - retry later
      } else if (pick) {
        outcome = "LOSS"; // recorded missed pick awaiting resolution
      } else {
        // No pick at all. Only charge stages that STARTED after joining.
        const first = fixtures
          .filter((f) => f.stage === stage)
          .map((f) => f.kickoffUtc.getTime())
          .sort((a, b) => a - b)[0];
        if (first === undefined || entry.createdAt.getTime() > first) continue;
        outcome = "LOSS";
        await db
          .insert(survivorPick)
          .values({ survivorEntryId: entry.id, stage, nationalTeamId: null })
          .onConflictDoNothing();
        summary.missedCharged += 1;
      }

      await db
        .update(survivorPick)
        .set({ resolvedOutcome: outcome, updatedAt: new Date() })
        .where(
          and(
            eq(survivorPick.survivorEntryId, entry.id),
            eq(survivorPick.stage, stage),
          ),
        );
      summary.resolved += 1;

      if (outcome === "LOSS") {
        lives -= 1;
        if (lives <= 0) eliminatedAt = stage;
      }
    }

    if (lives !== entry.livesRemaining || eliminatedAt) {
      await db
        .update(survivorEntry)
        .set({
          livesRemaining: Math.max(lives, 0),
          ...(eliminatedAt ? { eliminatedAtStage: eliminatedAt } : {}),
        })
        .where(eq(survivorEntry.id, entry.id));
      if (eliminatedAt) {
        summary.eliminated += 1;
        try {
          const [m] = await db
            .select()
            .from(manager)
            .where(eq(manager.id, entry.managerId));
          await recordEvent(db, leagueId, "SURVIVOR_ELIMINATED", {
            managerId: entry.managerId,
            managerName: m?.displayName ?? `#${entry.managerId}`,
            stage: eliminatedAt,
          });
        } catch {
          /* best-effort */
        }
      }
    }
  }
  return summary;
}

/** Resolve every league with survivor entries; fault-tolerant per league. */
export async function resolveAllSurvivor(
  db: Db,
): Promise<{ leagues: number; resolved: number; errors: number }> {
  const rows = await db
    .selectDistinct({ leagueId: survivorEntry.leagueId })
    .from(survivorEntry);
  let resolved = 0;
  let errors = 0;
  for (const r of rows) {
    try {
      const s = await resolveSurvivor(db, r.leagueId);
      resolved += s.resolved;
    } catch {
      errors += 1;
    }
  }
  return { leagues: rows.length, resolved, errors };
}

export interface SurvivorBoardEntry {
  managerId: number;
  managerName: string;
  livesRemaining: number;
  eliminatedAtStage: Stage | null;
  picks: Array<{
    stage: Stage;
    nationalTeamId: number | null;
    teamName: string | null;
    resolvedOutcome: string | null;
    /** Hidden (null team fields) for OTHER managers until the stage locks. */
    hidden: boolean;
  }>;
}

/** The pool board. Other managers' unlocked picks are masked. */
export async function getSurvivorBoard(
  db: Db,
  leagueId: number,
  viewerManagerId: number,
  now = new Date(),
): Promise<SurvivorBoardEntry[]> {
  const entries = await db
    .select({
      id: survivorEntry.id,
      managerId: survivorEntry.managerId,
      livesRemaining: survivorEntry.livesRemaining,
      eliminatedAtStage: survivorEntry.eliminatedAtStage,
      managerName: manager.displayName,
    })
    .from(survivorEntry)
    .innerJoin(manager, eq(manager.id, survivorEntry.managerId))
    .where(eq(survivorEntry.leagueId, leagueId));
  if (entries.length === 0) return [];

  const picks = await db
    .select({
      survivorEntryId: survivorPick.survivorEntryId,
      stage: survivorPick.stage,
      nationalTeamId: survivorPick.nationalTeamId,
      resolvedOutcome: survivorPick.resolvedOutcome,
      teamName: nationalTeam.name,
    })
    .from(survivorPick)
    .leftJoin(nationalTeam, eq(nationalTeam.id, survivorPick.nationalTeamId))
    .where(
      inArray(
        survivorPick.survivorEntryId,
        entries.map((e) => e.id),
      ),
    );

  const kicks = await db
    .select({ stage: fixture.stage, kickoffUtc: fixture.kickoffUtc })
    .from(fixture);
  const firstByStage = new Map<Stage, number>();
  for (const k of kicks) {
    const cur = firstByStage.get(k.stage);
    const t = k.kickoffUtc.getTime();
    if (cur === undefined || t < cur) firstByStage.set(k.stage, t);
  }
  const locked = (stage: Stage): boolean => {
    const t = firstByStage.get(stage);
    return t !== undefined && now.getTime() >= t;
  };

  return entries
    .map((e) => ({
      managerId: e.managerId,
      managerName: e.managerName,
      livesRemaining: e.livesRemaining,
      eliminatedAtStage: e.eliminatedAtStage,
      picks: picks
        .filter((p) => p.survivorEntryId === e.id)
        .sort(
          (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage),
        )
        .map((p) => {
          const hidden = e.managerId !== viewerManagerId && !locked(p.stage);
          return {
            stage: p.stage,
            nationalTeamId: hidden ? null : p.nationalTeamId,
            teamName: hidden ? null : p.teamName,
            resolvedOutcome: p.resolvedOutcome,
            hidden,
          };
        }),
    }))
    .sort(
      (a, b) =>
        b.livesRemaining - a.livesRemaining || a.managerId - b.managerId,
    );
}
