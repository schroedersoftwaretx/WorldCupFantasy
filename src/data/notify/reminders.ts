/**
 * Lock reminders (phase-08 8.2, built on the Phase 0 notification hub).
 *
 * Cron entry point: for every league whose NEXT scoring period's first
 * kickoff is inside the reminder window (default 24h), nudge the managers
 * who still have something to do before the lock:
 *
 *   - SET_LINEUP leagues: teams with no lineup row SUBMITTED for that
 *     period (an earlier lineup rolls forward, so the message says
 *     "confirm or update", not "you'll score zero").
 *   - survivor-flag leagues: alive entrants with no pick for the period's
 *     stage (a missed pick costs a life - that one is urgent).
 *
 * Idempotent under cron reruns: every enqueue carries a dedupeKey of
 * (kind, league, period, manager), and the hub suppresses repeats per
 * manager+channel. Managers can mute the LOCK_REMINDER category in
 * notification settings.
 *
 * Pure service: takes a Db and a clock; no HTTP/auth/env here.
 */
import { and, eq, isNull } from "drizzle-orm";

import {
  assignFixturesToPeriods,
  getScoringPeriods,
  type PeriodRef,
} from "../competition/periods.js";
import type { Db } from "../db/client.js";
import {
  fantasyTeam,
  fixture,
  league,
  lineup,
  survivorEntry,
  survivorPick,
  type Stage,
} from "../db/schema.js";
import { getFlags } from "../league/feature-flags.js";
import { enqueue } from "./service.js";

const DEFAULT_WINDOW_HOURS = 24;
const MS_PER_HOUR = 3_600_000;

export interface ReminderSummary {
  leaguesChecked: number;
  lineupReminders: number;
  survivorReminders: number;
}

/** The next period (smallest ordinal) whose first kickoff is in (now, now+window]. */
function nextPeriodInWindow(
  periods: readonly PeriodRef[],
  firstKickoffByOrdinal: ReadonlyMap<number, Date>,
  now: Date,
  windowMs: number,
): { ref: PeriodRef; firstKickoff: Date } | null {
  let best: { ref: PeriodRef; firstKickoff: Date } | null = null;
  for (const p of periods) {
    const first = firstKickoffByOrdinal.get(p.ordinal);
    if (!first) continue;
    if (first <= now) continue;
    if (first.getTime() - now.getTime() > windowMs) continue;
    if (best === null || p.ordinal < best.ref.ordinal) {
      best = { ref: p, firstKickoff: first };
    }
  }
  return best;
}

/**
 * Send every due lock reminder. Safe to call on every cron tick.
 */
export async function sendLockReminders(
  db: Db,
  now: Date = new Date(),
  windowHours: number = DEFAULT_WINDOW_HOURS,
): Promise<ReminderSummary> {
  const summary: ReminderSummary = {
    leaguesChecked: 0,
    lineupReminders: 0,
    survivorReminders: 0,
  };
  const windowMs = windowHours * MS_PER_HOUR;

  const leagues = await db.select().from(league).where(eq(league.status, "ACTIVE"));
  if (leagues.length === 0) return summary;

  // Fixtures are global; load once and index first kickoff per (competition,
  // ordinal) lazily per league (periods differ per competition).
  const fixtures = await db.select().from(fixture);

  for (const lg of leagues) {
    const flags = await getFlags(db, lg.id);
    const wantsLineup = lg.format === "SET_LINEUP";
    const wantsSurvivor = flags.survivor;
    if (!wantsLineup && !wantsSurvivor) continue;
    summary.leaguesChecked += 1;

    const periods = await getScoringPeriods(db, lg.competitionId);
    const byFixture = assignFixturesToPeriods(periods, fixtures);
    const firstByOrdinal = new Map<number, Date>();
    for (const f of fixtures) {
      const ord = byFixture.get(f.id);
      if (ord === undefined) continue;
      const cur = firstByOrdinal.get(ord);
      if (!cur || f.kickoffUtc < cur) firstByOrdinal.set(ord, f.kickoffUtc);
    }
    const next = nextPeriodInWindow(periods, firstByOrdinal, now, windowMs);
    if (!next) continue;
    const { ref, firstKickoff } = next;
    const when = firstKickoff.toISOString().slice(0, 16).replace("T", " ");

    const teams = await db
      .select()
      .from(fantasyTeam)
      .where(eq(fantasyTeam.leagueId, lg.id));

    if (wantsLineup && ref.id !== null) {
      // Who has already submitted for THIS period?
      const submitted = new Set(
        (
          await db
            .select({ fantasyTeamId: lineup.fantasyTeamId })
            .from(lineup)
            .where(eq(lineup.scoringPeriodId, ref.id))
        ).map((r) => r.fantasyTeamId),
      );
      for (const team of teams) {
        if (submitted.has(team.id)) continue;
        const rows = await enqueue(db, {
          managerId: team.managerId,
          type: "LOCK_REMINDER",
          title: `Lineup locks soon - ${ref.label}`,
          body:
            `${lg.name}: ${ref.label} locks at first kickoff (${when} UTC). ` +
            `You haven't submitted a lineup for this period - your previous ` +
            `XI rolls forward unless you update it.`,
          leagueId: lg.id,
          link: `/leagues/${lg.id}/lineup`,
          dedupeKey: `lock-reminder:lineup:${lg.id}:${ref.ordinal}:${team.managerId}`,
        });
        if (rows.length > 0) summary.lineupReminders += 1;
      }
    }

    if (wantsSurvivor && ref.stageCode !== null) {
      const stage = ref.stageCode as Stage;
      const entries = await db
        .select()
        .from(survivorEntry)
        .where(
          and(
            eq(survivorEntry.leagueId, lg.id),
            isNull(survivorEntry.eliminatedAtStage),
          ),
        );
      for (const entry of entries) {
        const [pick] = await db
          .select()
          .from(survivorPick)
          .where(
            and(
              eq(survivorPick.survivorEntryId, entry.id),
              eq(survivorPick.stage, stage),
            ),
          );
        if (pick && pick.nationalTeamId !== null) continue;
        const rows = await enqueue(db, {
          managerId: entry.managerId,
          type: "LOCK_REMINDER",
          title: `Survivor pick due - ${ref.label}`,
          body:
            `${lg.name}: pick a nation for ${ref.label} before first ` +
            `kickoff (${when} UTC). A missed pick costs a life.`,
          leagueId: lg.id,
          link: `/leagues/${lg.id}/survivor`,
          dedupeKey: `lock-reminder:survivor:${lg.id}:${ref.ordinal}:${entry.managerId}`,
        });
        if (rows.length > 0) summary.survivorReminders += 1;
      }
    }
  }
  return summary;
}
