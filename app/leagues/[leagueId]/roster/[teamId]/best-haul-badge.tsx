/**
 * BestHaulBadge - surfaces a team's biggest single-match haul on its roster
 * page (Phase 7.1). Reuses the league "best-haul" award definition (which in
 * turn reuses the Phase 1 bestSingleMatchHauls query) and picks out this
 * team's row, scored against the league's OWN ruleset version. Renders nothing
 * if the team has no haul yet.
 */
import { eq } from "drizzle-orm";

import { LEAGUE_AWARDS } from "@/data/awards/registry";
import { league } from "@/data/db/schema";
import type { ScoringRuleset } from "@/data/scoring/ruleset";
import { getDb } from "@/web/db";
import { formatPoints } from "@/web/format";

export async function BestHaulBadge({
  leagueId,
  teamId,
}: {
  leagueId: number;
  teamId: number;
}) {
  try {
    const db = getDb();
    const [lg] = await db.select().from(league).where(eq(league.id, leagueId));
    if (!lg) return null;
    const rulesetVersion = (lg.scoringRuleset as ScoringRuleset).version;
    const def = LEAGUE_AWARDS.find((a) => a.id === "best-haul");
    if (!def) return null;
    const entries = await def.compute({ db, leagueId, rulesetVersion });
    const mine = entries.find((e) => e.fantasyTeamId === teamId);
    if (!mine) return null;
    return (
      <p className="subtitle">
        Biggest haul: <strong>{formatPoints(mine.value)} pts</strong> &mdash;{" "}
        {mine.subtitle}
      </p>
    );
  } catch {
    return null;
  }
}
