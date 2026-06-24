/**
 * Fixture listing with stat-coverage column.
 */

import { fixture, statLine } from "../../data/db/schema.js";
import type { Subcommand } from "../helpers.js";

export const fixturesCommands: Record<string, Subcommand> = {
  "fixtures:list": async ({ db }) => {
    const rows = await db
      .select({
        id: fixture.id,
        sourceFixtureId: fixture.sourceFixtureId,
        stage: fixture.stage,
        kickoff: fixture.kickoffUtc,
        status: fixture.status,
      })
      .from(fixture)
      .orderBy(fixture.kickoffUtc);
    if (rows.length === 0) {
      console.log("(no fixtures -- run ingest:schedule first)");
      return;
    }
    // Count stat_line rows per fixture for the coverage column.
    const statRows = await db
      .select({ fixtureId: statLine.fixtureId })
      .from(statLine);
    const statCount = new Map<number, number>();
    for (const r of statRows) {
      statCount.set(r.fixtureId, (statCount.get(r.fixtureId) ?? 0) + 1);
    }
    console.log(
      "sourceFixtureId        stage        kickoff (UTC)             status      stats",
    );
    for (const r of rows) {
      const stats = statCount.get(r.id) ?? 0;
      const statsLabel = stats > 0 ? `${stats} rows` : "none";
      const kickoff = r.kickoff.toISOString().slice(0, 16).replace("T", " ");
      console.log(
        `${r.sourceFixtureId.padEnd(22)} ${r.stage.padEnd(12)} ${kickoff}  ${r.status.padEnd(11)} ${statsLabel}`,
      );
    }
    console.log(`\n${rows.length} fixture(s) total`);
  },
};
