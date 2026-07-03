/**
 * Scoring periods as data (Phase 9).
 *
 * The standings loop used to iterate the hardcoded stage enum. It now asks
 * this service for the league's competition's scoring_period rows (ordered by
 * ordinal). Leagues with no competition_id - or a competition with no seeded
 * periods - fall back to the stage enum, which IS the seeded World Cup list,
 * so a pre-backfill league computes identically.
 *
 * Pure service: takes a Db and plain inputs; no HTTP/auth/env here.
 */
import { asc, eq } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import { scoringPeriod, stageEnum, type Stage } from "../db/schema.js";

/** One scoring period, decoupled from the stage enum. */
export interface PeriodRef {
  /** scoring_period.id; null for enum-fallback periods. */
  id: number | null;
  /** 1-based tournament order. */
  ordinal: number;
  /** Display label, e.g. "GW1", "Final". For fallback periods, the stage. */
  label: string;
  /** The stage enum value this period mirrors (cups); null for gameweeks. */
  stageCode: Stage | null;
}

/** The stage-enum periods - the pre-Phase-9 hardcoded list, as PeriodRefs. */
export function stageFallbackPeriods(): PeriodRef[] {
  return stageEnum.enumValues.map((stage, i) => ({
    id: null,
    ordinal: i + 1,
    label: stage,
    stageCode: stage,
  }));
}

/**
 * The scoring periods for a competition, in ordinal order. Falls back to the
 * stage enum when competitionId is null or the competition has no periods,
 * preserving pre-Phase-9 behavior exactly.
 */
export async function getScoringPeriods(
  db: Db | DbTx,
  competitionId: number | null,
): Promise<PeriodRef[]> {
  if (competitionId === null) return stageFallbackPeriods();
  const rows = await db
    .select()
    .from(scoringPeriod)
    .where(eq(scoringPeriod.competitionId, competitionId))
    .orderBy(asc(scoringPeriod.ordinal));
  if (rows.length === 0) return stageFallbackPeriods();
  return rows.map((r) => ({
    id: r.id,
    ordinal: r.ordinal,
    label: r.label,
    stageCode: r.stageCode,
  }));
}

/**
 * Assign each fixture to a period: by scoring_period_id when set (and the
 * period belongs to this competition), else by stage_code fallback. Returns
 * fixtureId -> ordinal. Fixtures matching no period are simply absent (they
 * contribute to no period, same as an unknown stage before).
 */
export function assignFixturesToPeriods(
  periods: readonly PeriodRef[],
  fixtures: ReadonlyArray<{
    id: number;
    stage: Stage;
    scoringPeriodId: number | null;
  }>,
): Map<number, number> {
  const byId = new Map<number, PeriodRef>();
  const byStage = new Map<Stage, PeriodRef>();
  for (const p of periods) {
    if (p.id !== null) byId.set(p.id, p);
    if (p.stageCode !== null && !byStage.has(p.stageCode)) byStage.set(p.stageCode, p);
  }
  const out = new Map<number, number>();
  for (const f of fixtures) {
    const p =
      (f.scoringPeriodId !== null ? byId.get(f.scoringPeriodId) : undefined) ??
      byStage.get(f.stage);
    if (p) out.set(f.id, p.ordinal);
  }
  return out;
}
