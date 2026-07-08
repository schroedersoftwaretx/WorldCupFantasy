/**
 * Unit tests for the pure survivor pick decision (phase-05 5.2).
 */
import { describe, expect, it } from "vitest";

import { decidePick } from "../../src/data/sidegames/survivor.js";
import type { Stage } from "../../src/data/db/schema.js";

function fx(
  stage: Stage,
  home: number,
  away: number,
  hs: number | null,
  as_: number | null,
  status: "SCHEDULED" | "LIVE" | "FINISHED" = "FINISHED",
) {
  return { stage, homeTeamId: home, awayTeamId: away, homeScore: hs, awayScore: as_, status };
}

describe("decidePick", () => {
  it("wins on goals, loses on goals", () => {
    expect(decidePick(1, "GROUP_1", [fx("GROUP_1", 1, 2, 2, 0)])).toBe("WIN");
    expect(decidePick(2, "GROUP_1", [fx("GROUP_1", 1, 2, 2, 0)])).toBe("LOSS");
  });

  it("a group-stage draw is not a win", () => {
    expect(decidePick(1, "GROUP_2", [fx("GROUP_2", 1, 2, 1, 1)])).toBe("LOSS");
  });

  it("not playing that stage is a loss", () => {
    expect(decidePick(3, "GROUP_1", [fx("GROUP_1", 1, 2, 2, 0)])).toBe("LOSS");
  });

  it("a level knockout stays undecided until a later round is ingested", () => {
    expect(decidePick(1, "R16", [fx("R16", 1, 2, 1, 1)])).toBeNull();
  });

  it("a level knockout resolves via the later round (pens winner/loser)", () => {
    const fixtures = [
      fx("R16", 1, 2, 1, 1),
      fx("QF", 2, 3, null, null, "SCHEDULED"),
    ];
    expect(decidePick(2, "R16", fixtures)).toBe("WIN");
    expect(decidePick(1, "R16", fixtures)).toBe("LOSS");
  });
});
