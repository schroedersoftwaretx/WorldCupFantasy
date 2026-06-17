/**
 * One-off migration: re-point every league onto a correctly-hashed scoring
 * ruleset after the hashRuleset fix, then rebuild scores + projections.
 *
 * Why: hashRuleset previously excluded the nested goalByPosition /
 * cleanSheetByPosition maps from the version hash, so every league shared the
 * version "wcf-v1-07a20a31" regardless of its goal/clean-sheet values, and the
 * raised default goal values (GK12/DEF7/MID6/FWD5) never produced a new
 * version. After the fix the default version changes, so persisted rows keyed
 * by ruleset_version must be rebuilt.
 *
 * What it does:
 *   1. Reads each league's stored scoring_ruleset values.
 *   2. Leagues whose values match a default shape (old GK10/DEF6/MID5/FWD4 or
 *      current GK12/DEF7/MID6/FWD5) are normalised to the current
 *      DEFAULT_RULESET (new goal values + correct version).
 *   3. Custom leagues keep their own values but get a correct version hash.
 *   4. recomputeAllRulesets + recomputeProjections rebuild score rows; standings
 *      snapshots are refreshed.
 *   5. score_entry / projected_score_entry rows under versions no league (nor
 *      the default) references are deleted.
 *
 *   # dry run (default) - prints the plan, changes nothing:
 *   node --env-file=.env --import tsx scripts/repoint-leagues.ts
 *   # apply:
 *   node --env-file=.env --import tsx scripts/repoint-leagues.ts --apply
 */
import { eq, notInArray } from "drizzle-orm";

import { closeDb, createDb } from "../src/data/db/client.js";
import { league, projectedScoreEntry, scoreEntry } from "../src/data/db/schema.js";
import { recomputeProjections } from "../src/data/projection/recompute-projections.js";
import { recomputeAllRulesets } from "../src/data/scoring/recompute.js";
import {
  DEFAULT_RULESET,
  buildRuleset,
  type ScoringRuleset,
} from "../src/data/scoring/ruleset.js";
import { captureAllStandingsSnapshots } from "../src/data/standings/snapshot.js";

const APPLY = process.argv.includes("--apply");

/** Stable JSON for deep comparison (recursively sorts keys). */
function stable(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return Object.keys(o)
        .sort()
        .reduce<Record<string, unknown>>((a, k) => ((a[k] = sort(o[k])), a), {});
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

function valuesOf(rs: ScoringRuleset): Omit<ScoringRuleset, "version"> {
  const { version: _v, ...rest } = rs;
  return rest;
}

async function main(): Promise<void> {
  const url = process.env["DIRECT_DATABASE_URL"] || process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL / DIRECT_DATABASE_URL not set");
  const db = createDb({ connectionString: url, max: 2 });

  try {
    const newDefaultValues = valuesOf(DEFAULT_RULESET);
    const oldDefaultValues = {
      ...newDefaultValues,
      goalByPosition: { GK: 10, DEF: 6, MID: 5, FWD: 4 },
    };
    const defaultShapes = new Set([stable(newDefaultValues), stable(oldDefaultValues)]);

    const leagues = await db
      .select({ id: league.id, name: league.name, scoringRuleset: league.scoringRuleset })
      .from(league);

    console.log(`Found ${leagues.length} league(s). Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);
    console.log(`Corrected DEFAULT_RULESET version: ${DEFAULT_RULESET.version}\n`);

    const updates: { id: number; name: string; from: string; to: ScoringRuleset; kind: string }[] = [];
    for (const lg of leagues) {
      const stored = lg.scoringRuleset as ScoringRuleset;
      const storedValues = valuesOf(stored);
      const isDefault = defaultShapes.has(stable(storedValues));
      const target = isDefault ? DEFAULT_RULESET : buildRuleset(storedValues);
      const changed = stable(stored) !== stable(target);
      const kind = isDefault ? "default->new-default" : "custom (re-hash, values kept)";
      if (changed) {
        updates.push({ id: lg.id, name: lg.name, from: stored.version, to: target, kind });
        console.log(
          `  league ${lg.id} "${lg.name}": ${stored.version} -> ${target.version}  [${kind}]`,
        );
      } else {
        console.log(`  league ${lg.id} "${lg.name}": ${stored.version} (already correct, skip)`);
      }
    }

    if (!APPLY) {
      console.log(`\nDRY RUN: ${updates.length} league(s) would change. Re-run with --apply.`);
      return;
    }

    for (const u of updates) {
      await db.update(league).set({ scoringRuleset: u.to }).where(eq(league.id, u.id));
    }
    console.log(`\nUpdated ${updates.length} league(s).`);

    console.log("Recomputing scores for all league rulesets...");
    const score = await recomputeAllRulesets(db);
    console.log(
      `  rulesets=${score.rulesets} inserted=${score.total.inserted} updated=${score.total.updated} skipped=${score.total.skipped}`,
    );

    console.log("Recomputing projections (default ruleset)...");
    const proj = await recomputeProjections(db, DEFAULT_RULESET);
    console.log(`  projections=${JSON.stringify(proj)}`);

    console.log("Refreshing standings snapshots...");
    const snap = await captureAllStandingsSnapshots(db);
    console.log(`  leagues=${snap.leagues} written=${snap.written} errors=${snap.errors}`);

    // Delete score rows under versions no league (nor the default) references.
    const live = new Set<string>([DEFAULT_RULESET.version]);
    const after = await db.select({ scoringRuleset: league.scoringRuleset }).from(league);
    for (const r of after) {
      const v = (r.scoringRuleset as ScoringRuleset | null)?.version;
      if (v) live.add(v);
    }
    const liveArr = [...live];
    const delScore = await db
      .delete(scoreEntry)
      .where(notInArray(scoreEntry.rulesetVersion, liveArr))
      .returning({ v: scoreEntry.rulesetVersion });
    const delProj = await db
      .delete(projectedScoreEntry)
      .where(notInArray(projectedScoreEntry.rulesetVersion, liveArr))
      .returning({ v: projectedScoreEntry.rulesetVersion });
    console.log(
      `Pruned orphaned rows: score_entry=${delScore.length} projected_score_entry=${delProj.length} (live versions: ${liveArr.join(", ")})`,
    );

    console.log("\nDone.");
  } finally {
    await closeDb(db);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
