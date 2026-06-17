/**
 * Unit tests for the roster-page pitch formation (computeLineup).
 *
 * Regression: the pitch used to derive its formation from DRAFT RANK, so it
 * disagreed with the best-ball XI that actually scored (e.g. showing 5-3-2 when
 * the optimum was 4-4-2). When the roster carries real points it must now show
 * the genuine best-ball optimum — the same one the standings compute.
 */
import { describe, expect, it } from "vitest";

import { computeLineup } from "../../app/leagues/[leagueId]/draft/best-lineup.js";

type P = {
  playerId: number;
  fullName: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  draftRank?: number | null;
  points?: number;
};

let nextId = 1;
function mk(
  position: P["position"],
  points: number,
  draftRank: number | null = null,
): P {
  const id = nextId++;
  return {
    playerId: id,
    fullName: `${position}-${id}`,
    position,
    points,
    ...(draftRank !== null ? { draftRank } : {}),
  };
}

describe("computeLineup (roster pitch formation)", () => {
  it("uses the best-ball points optimum, not draft rank (4-4-2 over 5-3-2)", () => {
    // Points engineered so 4 DEF + 4 MID + 2 FWD maximises the XI:
    //   GK 5 | DEF 9,8,7,6,1 | MID 10,10,9,9 | FWD 8,2,1
    //   4-4-2 = 5 + (9+8+7+6) + (10+10+9+9) + (8+2) = 83  <- best
    //   5-3-2 = 5 + (30+1)    + (29)         + (10)   = 75
    const roster: P[] = [
      mk("GK", 5),
      mk("GK", 1),
      mk("DEF", 9),
      mk("DEF", 8),
      mk("DEF", 7),
      mk("DEF", 6),
      mk("DEF", 1),
      mk("MID", 10),
      mk("MID", 10),
      mk("MID", 9),
      mk("MID", 9),
      mk("FWD", 8),
      mk("FWD", 2),
      mk("FWD", 1),
    ];

    const { lineup, formation } = computeLineup(roster);
    expect(formation).toBe("4-4-2");
    // Filled (non-placeholder) counts per row match the formation.
    const filled = (slots: { name: string | null }[]) =>
      slots.filter((s) => s.name !== null).length;
    expect(filled(lineup.gk)).toBe(1);
    expect(filled(lineup.def)).toBe(4);
    expect(filled(lineup.mid)).toBe(4);
    expect(filled(lineup.fwd)).toBe(2);
  });

  it("falls back to the draft-rank projection when no points are present", () => {
    // No `points` anywhere -> the rank heuristic runs. With a base 9-man shell
    // (4 DEF, 2 MID, 2 FWD) and no flex players, that is a 4-2-2 projection,
    // independent of any scoring.
    const roster: P[] = [
      { playerId: 100, fullName: "GK", position: "GK", draftRank: 1 },
      { playerId: 101, fullName: "D1", position: "DEF", draftRank: 2 },
      { playerId: 102, fullName: "D2", position: "DEF", draftRank: 3 },
      { playerId: 103, fullName: "D3", position: "DEF", draftRank: 4 },
      { playerId: 104, fullName: "D4", position: "DEF", draftRank: 5 },
      { playerId: 105, fullName: "M1", position: "MID", draftRank: 6 },
      { playerId: 106, fullName: "M2", position: "MID", draftRank: 7 },
      { playerId: 107, fullName: "F1", position: "FWD", draftRank: 8 },
      { playerId: 108, fullName: "F2", position: "FWD", draftRank: 9 },
    ];
    const { formation } = computeLineup(roster);
    expect(formation).toBe("4-2-2");
  });
});
