/**
 * Unit tests for the chips overlay pieces that are pure: the SET_LINEUP
 * scorer's captain multiplier and BENCH_BOOST bench slots. (The best-ball
 * captain-through-the-optimizer path is covered by integration tests.)
 */
import { describe, expect, it } from "vitest";

import type { LineupRow, Position } from "../../src/data/db/schema.js";
import {
  scoreSetLineupPeriod,
  type SetLineupSlotInput,
} from "../../src/data/standings/set-lineup.js";

const XI = [1, 10, 11, 12, 13, 20, 21, 22, 30, 31, 32];

function mkRow(captain: number, vice: number | null): LineupRow {
  return {
    fantasyTeamId: 1,
    scoringPeriodId: 101,
    playerIds: XI,
    captainPlayerId: captain,
    viceCaptainPlayerId: vice,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
  };
}

const slots = new Map<number, SetLineupSlotInput>(
  XI.map((pid, i) => [
    pid,
    {
      position: (pid === 1 ? "GK" : pid < 20 ? "DEF" : pid < 30 ? "MID" : "FWD") as Position,
      points: i + 1, // 1..11 -> base total 66
      fullName: `P${pid}`,
    },
  ]),
);

describe("scoreSetLineupPeriod chips options", () => {
  it("triple captain: multiplier 3 when the captain featured", () => {
    // Captain pid 32 has 11 points -> x3 adds 22: total 88.
    const r = scoreSetLineupPeriod(mkRow(32, null), slots, new Set(XI), {
      captainMultiplier: 3,
    });
    expect(r.points).toBe(88);
    expect(r.xi.find((s) => s.playerId === 32)?.points).toBe(33);
  });

  it("triple captain applies to the promoted vice too", () => {
    const featured = new Set(XI.filter((p) => p !== 32));
    const r = scoreSetLineupPeriod(mkRow(32, 1), slots, featured, {
      captainMultiplier: 3,
    });
    // Vice pid 1 (1 point) tripled: 66 - 0 (captain scored 11 raw, still
    // counted once) + 2 extra for the vice = 68.
    expect(r.xi.find((s) => s.playerId === 1)?.points).toBe(3);
    expect(r.points).toBe(68);
  });

  it("bench boost appends raw bench slots and labels the formation ALL", () => {
    const bench = new Map<number, SetLineupSlotInput>([
      [90, { position: "DEF", points: 4, fullName: "B90" }],
      [91, { position: "FWD", points: 6, fullName: "B91" }],
    ]);
    const r = scoreSetLineupPeriod(mkRow(1, null), slots, new Set(XI), {
      benchSlots: bench,
    });
    // 66 + captain double (+1) + bench 10 = 77.
    expect(r.points).toBe(77);
    expect(r.formation).toBe("ALL");
    expect(r.xi).toHaveLength(13);
    expect(r.xi.find((s) => s.playerId === 91)?.points).toBe(6);
  });

  it("defaults keep the plain x2 behavior", () => {
    const r = scoreSetLineupPeriod(mkRow(1, null), slots, new Set(XI));
    expect(r.points).toBe(67);
  });
});
