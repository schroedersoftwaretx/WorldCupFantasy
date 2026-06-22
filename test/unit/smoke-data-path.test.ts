/**
 * Data-path smoke test — mock feed -> mapping layer -> scoring, no database.
 *
 * The integration suite covers this path end-to-end but needs a Postgres
 * container (Testcontainers/Docker), so it can't run on a machine without
 * Docker or in a lightweight CI job. This smoke test drives the core
 * provider -> mapping -> scoring pipeline against the committed fixture set
 * using only the filesystem: it runs fast everywhere and guards the
 * FixtureMockProvider + api-football-mapping code that the production
 * SofaScore feed shares.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { Position } from "../../src/data/db/schema.js";
import { FixtureMockProvider } from "../../src/data/provider/mock.js";
import { DEFAULT_RULESET } from "../../src/data/scoring/ruleset.js";
import { scoreStatLine, type ScorableStatLine } from "../../src/data/scoring/score.js";

const FIXTURE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "provider",
);
const FIXTURE_ID = "8001";
const POSITIONS: Position[] = ["GK", "DEF", "MID", "FWD"];

describe("data-path smoke (mock feed -> mapping -> scoring, no DB)", () => {
  const provider = new FixtureMockProvider({ root: FIXTURE_ROOT });

  it("maps squads into well-formed players", async () => {
    const squads = await provider.fetchSquads();
    expect(squads.length).toBeGreaterThan(0);
    for (const squad of squads) {
      expect(squad.team.sourceTeamId).toBeTruthy();
      expect(squad.team.name).toBeTruthy();
      expect(squad.players.length).toBeGreaterThan(0);
      for (const p of squad.players) {
        expect(p.sourcePlayerId).toBeTruthy();
        expect(p.fullName).toBeTruthy();
        expect(POSITIONS).toContain(p.position);
      }
    }
  });

  it("maps the schedule and exposes the finished fixture", async () => {
    const schedule = await provider.fetchSchedule();
    expect(schedule.length).toBeGreaterThan(0);
    const fixture = schedule.find((f) => f.sourceFixtureId === FIXTURE_ID);
    expect(fixture, `fixture ${FIXTURE_ID} present in schedule`).toBeDefined();
    expect(fixture!.status).toBe("FINISHED");
    expect(fixture!.homeScore).not.toBeNull();
    expect(fixture!.awayScore).not.toBeNull();
  });

  it("maps fixture stats and scores every line without a database", async () => {
    const [squads, statLines] = await Promise.all([
      provider.fetchSquads(),
      provider.fetchFixtureStats(FIXTURE_ID),
    ]);
    expect(statLines.length).toBeGreaterThan(0);

    const positionById = new Map<string, Position>();
    for (const squad of squads) {
      for (const p of squad.players) positionById.set(p.sourcePlayerId, p.position);
    }

    let matchedToSquad = 0;
    for (const line of statLines) {
      expect(line.sourceFixtureId).toBe(FIXTURE_ID);
      expect(line.sourceRevision).toBeTruthy();
      expect(Number.isFinite(line.minutesPlayed)).toBe(true);

      const position = positionById.get(line.sourcePlayerId);
      if (position) matchedToSquad++;

      const result = scoreStatLine(
        line as ScorableStatLine,
        position ?? "MID",
        DEFAULT_RULESET,
      );
      expect(Number.isFinite(result.points)).toBe(true);

      const breakdownSum = Object.values(result.breakdown).reduce((a, b) => a + b, 0);
      expect(result.points).toBeCloseTo(breakdownSum, 1);
    }

    // The fixture's players resolve against the squad feed (same dataset).
    expect(matchedToSquad).toBeGreaterThan(0);
  });
});
