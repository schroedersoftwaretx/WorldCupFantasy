/**
 * Projected chip impact (roadmap "projected chip impact") - DERIVED.
 *
 * For the NEXT period that hasn't kicked off, estimate what each remaining
 * chip would be worth from Phase 6 projections (projected_score_entry):
 *
 *   base          projected best-ball XI total for the period
 *   TRIPLE_CAPTAIN  +1x the captain's projected points (a nominated captain
 *                   already scores x2 under the chips flag; TC lifts him to
 *                   x3). Assumes the nominated captain, falling back to the
 *                   team's best projected player.
 *   BENCH_BOOST     the projected points of everyone OUTSIDE the best XI
 *   STAGE_BOOST     +1x the whole period total (doubles it)
 *
 * Returns null when the tournament is over or no projections exist for the
 * period (the odds pipeline is optional) - the UI hides the card entirely.
 * These are estimates for decision support; actual chip scoring happens in
 * the standings overlay, best-ball and set-lineup alike.
 *
 * Pure service: takes a Db and plain inputs; no HTTP/auth/env here.
 */
import { and, eq, inArray } from "drizzle-orm";

import {
  assignFixturesToPeriods,
  getScoringPeriods,
} from "../competition/periods.js";
import type { Db } from "../db/client.js";
import {
  fixture,
  periodCaptain,
  player,
  projectedScoreEntry,
  rosterSlot,
  type LeagueRow,
  type Position,
} from "../db/schema.js";
import type { ScoringRuleset } from "../scoring/ruleset.js";
import {
  canFieldFormation,
  formationsForSet,
  optimizeBestBall,
  type ScoredPlayer,
} from "../standings/lineup.js";

export interface ProjectedChipImpact {
  ordinal: number;
  label: string;
  /** Projected best-ball XI total for the period. */
  base: number;
  /** Extra points TRIPLE_CAPTAIN would add (+1x the captain). */
  tripleCaptain: number;
  /** The player the TC estimate assumes as captain. */
  captainName: string;
  /** Whether that captain is actually nominated (vs best-player fallback). */
  captainNominated: boolean;
  /** Extra points BENCH_BOOST would add (projected non-XI sum). */
  benchBoost: number;
  /** Extra points STAGE_BOOST would add (doubles the period total). */
  stageBoost: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Estimate chip impact for one team's next not-yet-started period.
 * Null when there is no upcoming period or no projections for it.
 */
export async function projectedChipImpact(
  db: Db,
  lg: LeagueRow,
  fantasyTeamId: number,
  now: Date = new Date(),
): Promise<ProjectedChipImpact | null> {
  const periods = await getScoringPeriods(db, lg.competitionId);
  const fixtures = await db.select().from(fixture);
  const byFixture = assignFixturesToPeriods(periods, fixtures);
  const firstByOrdinal = new Map<number, Date>();
  for (const f of fixtures) {
    const ord = byFixture.get(f.id);
    if (ord === undefined) continue;
    const cur = firstByOrdinal.get(ord);
    if (!cur || f.kickoffUtc < cur) firstByOrdinal.set(ord, f.kickoffUtc);
  }
  // Next period = smallest ordinal with fixtures whose first kickoff is
  // still ahead (periods without fixtures can't have projections anyway).
  let next: { ordinal: number; label: string; id: number | null } | null = null;
  for (const p of periods) {
    const first = firstByOrdinal.get(p.ordinal);
    if (!first || first <= now) continue;
    if (next === null || p.ordinal < next.ordinal) {
      next = { ordinal: p.ordinal, label: p.label, id: p.id };
    }
  }
  if (!next) return null;
  const periodFixtureIds = new Set(
    fixtures.filter((f) => byFixture.get(f.id) === next.ordinal).map((f) => f.id),
  );

  const slots = await db
    .select({
      playerId: rosterSlot.playerId,
      fullName: player.fullName,
      position: player.position,
    })
    .from(rosterSlot)
    .innerJoin(player, eq(player.id, rosterSlot.playerId))
    .where(eq(rosterSlot.fantasyTeamId, fantasyTeamId));
  if (slots.length === 0) return null;

  const rulesetVersion = (lg.scoringRuleset as ScoringRuleset).version;
  const projected = await db
    .select()
    .from(projectedScoreEntry)
    .where(
      inArray(
        projectedScoreEntry.playerId,
        slots.map((s) => s.playerId),
      ),
    );
  const pointsByPlayer = new Map<number, number>();
  for (const row of projected) {
    if (row.rulesetVersion !== rulesetVersion) continue;
    if (!periodFixtureIds.has(row.fixtureId)) continue;
    pointsByPlayer.set(
      row.playerId,
      (pointsByPlayer.get(row.playerId) ?? 0) + row.projectedPoints,
    );
  }
  if (pointsByPlayer.size === 0) return null;

  const scored: ScoredPlayer[] = slots.map((s) => ({
    playerId: s.playerId,
    position: s.position as Position,
    points: pointsByPlayer.get(s.playerId) ?? 0,
  }));
  const leagueFormations = formationsForSet(lg.formationSet);
  if (!canFieldFormation(scored, leagueFormations)) return null;
  const best = optimizeBestBall(scored, leagueFormations);
  const base = round2(best.points);
  const allSum = round2(scored.reduce((sum, p) => sum + p.points, 0));

  // Captain: the nominated one for this period, else best projected player.
  let captainId: number | null = null;
  if (next.id !== null) {
    const [cap] = await db
      .select()
      .from(periodCaptain)
      .where(
        and(
          eq(periodCaptain.fantasyTeamId, fantasyTeamId),
          eq(periodCaptain.scoringPeriodId, next.id),
        ),
      );
    captainId = cap?.playerId ?? null;
  }
  const captainNominated = captainId !== null;
  if (captainId === null) {
    const top = [...scored].sort(
      (a, b) => b.points - a.points || a.playerId - b.playerId,
    )[0];
    captainId = top?.playerId ?? null;
  }
  if (captainId === null) return null;
  const captainPoints = pointsByPlayer.get(captainId) ?? 0;
  const nameById = new Map(slots.map((s) => [s.playerId, s.fullName]));

  return {
    ordinal: next.ordinal,
    label: next.label,
    base,
    tripleCaptain: round2(captainPoints),
    captainName: nameById.get(captainId) ?? `#${captainId}`,
    captainNominated,
    benchBoost: round2(allSum - base),
    stageBoost: base,
  };
}
