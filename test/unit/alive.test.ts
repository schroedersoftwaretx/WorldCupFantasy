/**
 * Unit tests for tournament survivorship (computeAliveState), including the
 * 2026-07 bug: a team that lost a knockout shootout (fixture level after
 * extra time) stayed "alive" forever because the fixture alone cannot name
 * the loser. Now the next ingested round resolves it: the winner appears in
 * a later fixture, the loser does not.
 */
import { describe, expect, it } from "vitest";

import {
  computeAliveState,
  type AliveFixture,
  type AliveTeam,
} from "../../src/web/alive.js";

const T = (id: number): AliveTeam => ({ id, status: "ACTIVE" });

function fx(
  stage: AliveFixture["stage"],
  home: number,
  away: number,
  homeScore: number | null,
  awayScore: number | null,
  status = "FINISHED",
  kickoff = "2026-06-15T18:00:00Z",
): AliveFixture {
  return {
    stage,
    status,
    homeTeamId: home,
    awayTeamId: away,
    homeScore,
    awayScore,
    kickoffUtc: new Date(kickoff),
  };
}

describe("computeAliveState", () => {
  it("everyone is alive before the first finished match", () => {
    const { started, aliveByTeamId } = computeAliveState(
      [T(1), T(2)],
      [fx("GROUP_1", 1, 2, null, null, "SCHEDULED")],
    );
    expect(started).toBe(false);
    expect(aliveByTeamId.get(1)).toBe(true);
    expect(aliveByTeamId.get(2)).toBe(true);
  });

  it("a regulation knockout loser is out; the winner stays alive", () => {
    const { aliveByTeamId } = computeAliveState(
      [T(1), T(2)],
      [fx("R16", 1, 2, 2, 1)],
    );
    expect(aliveByTeamId.get(1)).toBe(true);
    expect(aliveByTeamId.get(2)).toBe(false);
  });

  it("a shootout (level) match keeps both alive until the next round is ingested", () => {
    const { aliveByTeamId } = computeAliveState(
      [T(1), T(2)],
      [fx("R16", 1, 2, 1, 1)],
    );
    expect(aliveByTeamId.get(1)).toBe(true);
    expect(aliveByTeamId.get(2)).toBe(true);
  });

  it("the shootout loser is out once a later round exists without them (the Netherlands case)", () => {
    // Team 2 "won on pens" and advanced to the QF; team 1 did not.
    const { aliveByTeamId } = computeAliveState(
      [T(1), T(2), T(3)],
      [
        fx("R16", 1, 2, 1, 1, "FINISHED", "2026-07-01T18:00:00Z"),
        fx("QF", 2, 3, null, null, "SCHEDULED", "2026-07-09T18:00:00Z"),
      ],
    );
    expect(aliveByTeamId.get(1)).toBe(false); // shootout loser - crossed out
    expect(aliveByTeamId.get(2)).toBe(true); // shootout winner
  });

  it("an SF shootout loser resolves via the third-place playoff", () => {
    const { aliveByTeamId } = computeAliveState(
      [T(1), T(2), T(3), T(4)],
      [
        fx("SF", 1, 2, 0, 0, "FINISHED", "2026-07-14T18:00:00Z"),
        // Team 1 lost on pens: they surface in the 3rd-place game -> alive.
        fx("THIRD_PLACE", 1, 3, null, null, "SCHEDULED", "2026-07-18T18:00:00Z"),
        fx("FINAL", 2, 4, null, null, "SCHEDULED", "2026-07-19T18:00:00Z"),
      ],
    );
    expect(aliveByTeamId.get(1)).toBe(true); // third-place game still to play
    expect(aliveByTeamId.get(2)).toBe(true); // in the final
  });

  it("terminal stages end the tournament for both sides", () => {
    const { aliveByTeamId } = computeAliveState(
      [T(1), T(2)],
      [fx("FINAL", 1, 2, 1, 1)],
    );
    expect(aliveByTeamId.get(1)).toBe(false);
    expect(aliveByTeamId.get(2)).toBe(false);
  });

  it("group-stage teams are out once knockouts exist without them", () => {
    const { aliveByTeamId } = computeAliveState(
      [T(1), T(2), T(3), T(4)],
      [
        fx("GROUP_1", 1, 2, 1, 0),
        fx("GROUP_1", 3, 4, 2, 0),
        fx("GROUP_2", 1, 3, 1, 1),
        fx("GROUP_2", 2, 4, 1, 1),
        fx("GROUP_3", 1, 4, 1, 0),
        fx("GROUP_3", 2, 3, 0, 2),
        fx("R32", 1, 3, null, null, "SCHEDULED"),
      ],
    );
    expect(aliveByTeamId.get(1)).toBe(true);
    expect(aliveByTeamId.get(3)).toBe(true);
    expect(aliveByTeamId.get(2)).toBe(false);
    expect(aliveByTeamId.get(4)).toBe(false);
  });

  it("an explicit ELIMINATED status always wins", () => {
    const { aliveByTeamId } = computeAliveState(
      [{ id: 1, status: "ELIMINATED" }, T(2)],
      [fx("GROUP_1", 1, 2, 3, 0)],
    );
    expect(aliveByTeamId.get(1)).toBe(false);
  });
});
