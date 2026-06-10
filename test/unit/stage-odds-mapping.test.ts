/**
 * Unit tests for the stage-odds mapping helpers: de-vigging The Odds API
 * outright/"to-reach" markets to per-team reach probabilities, and matching
 * Odds API team names to our national_team rows.
 */
import { describe, expect, it } from "vitest";

import {
  mapStageOutrights,
  matchTeamName,
  normalizeTeamName,
  type RawOutrightEvent,
} from "../../src/data/odds/stage-odds-mapping.js";

function event(prices: Record<string, number>, books = 1): RawOutrightEvent {
  const outcomes = Object.entries(prices).map(([name, price]) => ({ name, price }));
  return {
    id: "evt",
    sport_key: "soccer_fifa_world_cup_winner",
    bookmakers: Array.from({ length: books }, (_, i) => ({
      key: `book${i}`,
      title: `Book ${i}`,
      markets: [{ key: "outrights", outcomes }],
    })),
  };
}

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe("mapStageOutrights", () => {
  it("de-vigs a winner market so probabilities sum to 1", () => {
    const m = mapStageOutrights([event({ Brazil: 4, Spain: 4, France: 5, Argentina: 5 })], 1);
    expect(sum(m)).toBeCloseTo(1, 6);
    // raw implied: BR .25, SP .25, FR .2, AR .2 -> total .9 -> BR = .25/.9
    expect(m.get("Brazil")).toBeCloseTo(0.25 / 0.9, 6);
    expect(m.get("Brazil")!).toBeGreaterThan(m.get("France")!);
  });

  it("averages across bookmakers before de-vigging", () => {
    const single = mapStageOutrights([event({ Brazil: 4, Spain: 4, France: 5, Argentina: 5 })], 1);
    const triple = mapStageOutrights([event({ Brazil: 4, Spain: 4, France: 5, Argentina: 5 }, 3)], 1);
    expect(triple.get("Brazil")).toBeCloseTo(single.get("Brazil")!, 9);
  });

  it("scales a 'reach the final' market to two slots", () => {
    const m = mapStageOutrights(
      [event({ Brazil: 2.0, Spain: 2.5, France: 3.0, Argentina: 3.0, Germany: 6.0, England: 6.0 })],
      2,
    );
    expect(sum(m)).toBeCloseTo(2, 6);
    for (const p of m.values()) expect(p).toBeLessThanOrEqual(1);
  });

  it("clamps a runaway favourite to at most 1", () => {
    const m = mapStageOutrights([event({ Brazil: 1.01, Spain: 50, France: 50 })], 2);
    expect(m.get("Brazil")!).toBeLessThanOrEqual(1);
  });

  it("returns an empty map when no outrights market is present", () => {
    expect(mapStageOutrights([], 1).size).toBe(0);
    expect(mapStageOutrights([{ id: "e", sport_key: "x", bookmakers: [] }], 1).size).toBe(0);
  });
});

describe("matchTeamName", () => {
  const teams = [
    { id: 1, name: "United States" },
    { id: 2, name: "South Korea" },
    { id: 3, name: "Republic of Ireland" },
    { id: 4, name: "Côte d'Ivoire" },
    { id: 5, name: "Brazil" },
  ];

  it("matches exact and case-insensitive names", () => {
    expect(matchTeamName("Brazil", teams)).toBe(5);
    expect(matchTeamName("south korea", teams)).toBe(2);
  });

  it("matches across the 'Republic of' qualifier", () => {
    expect(matchTeamName("Ireland", teams)).toBe(3);
  });

  it("is accent-insensitive", () => {
    expect(matchTeamName("Cote d'Ivoire", teams)).toBe(4);
  });

  it("returns null for an unknown team", () => {
    expect(matchTeamName("Narnia", teams)).toBeNull();
  });
});

describe("normalizeTeamName", () => {
  it("strips accents, punctuation and the 'republic of' qualifier", () => {
    expect(normalizeTeamName("Côte d'Ivoire")).toBe("cote divoire");
    expect(normalizeTeamName("Republic of Ireland")).toBe("ireland");
  });
});
