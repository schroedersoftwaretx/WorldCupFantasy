/**
 * Unit tests for the pure per-period roster reconstruction (Priority 5).
 * The ledger is rolled BACK from the current roster: rows whose
 * effective_ordinal is after the asked-for period are reversed.
 */
import { describe, expect, it } from "vitest";

import {
  everRosteredPlayerIds,
  rosterAtOrdinal,
} from "../../src/data/transactions/effective-roster.js";
import type { RosterTransactionRow } from "../../src/data/db/schema.js";

let seq = 0;
function row(
  kind: "ADD" | "DROP" | "TRADE",
  playerId: number,
  from: number | null,
  to: number | null,
  effectiveOrdinal: number,
): RosterTransactionRow {
  seq += 1;
  return {
    id: seq,
    leagueId: 1,
    kind,
    playerId,
    fromFantasyTeamId: from,
    toFantasyTeamId: to,
    effectiveOrdinal,
    waiverClaimId: null,
    tradeId: null,
    createdAt: new Date(2026, 5, 1, 0, 0, seq),
  };
}

describe("rosterAtOrdinal", () => {
  it("returns the current roster when the ledger is empty", () => {
    expect(rosterAtOrdinal([1, 2, 3], 10, [], 1).sort()).toEqual([1, 2, 3]);
  });

  it("reverses a not-yet-effective add/drop pair", () => {
    // Current roster: dropped 5, added 9, effective from period 3.
    const ledger = [row("DROP", 5, 10, null, 3), row("ADD", 9, null, 10, 3)];
    // Period 2: the swap hasn't happened yet.
    expect(rosterAtOrdinal([1, 9], 10, ledger, 2).sort()).toEqual([1, 5]);
    // Period 3+: the swap is live.
    expect(rosterAtOrdinal([1, 9], 10, ledger, 3).sort()).toEqual([1, 9]);
  });

  it("handles a player who left and came back", () => {
    // P7 dropped effective period 2, re-added effective period 4.
    const ledger = [row("DROP", 7, 10, null, 2), row("ADD", 7, null, 10, 4)];
    expect(rosterAtOrdinal([7], 10, ledger, 1)).toEqual([7]); // pre-drop
    expect(rosterAtOrdinal([7], 10, ledger, 2)).toEqual([]); // gone
    expect(rosterAtOrdinal([7], 10, ledger, 3)).toEqual([]); // still gone
    expect(rosterAtOrdinal([7], 10, ledger, 4)).toEqual([7]); // back
  });

  it("applies trades from both team perspectives", () => {
    const ledger = [
      row("TRADE", 4, 10, 20, 5),
      row("TRADE", 8, 20, 10, 5),
    ];
    // Team 10 currently has 8 (traded 4 away).
    expect(rosterAtOrdinal([1, 8], 10, ledger, 4).sort()).toEqual([1, 4]);
    expect(rosterAtOrdinal([1, 8], 10, ledger, 5).sort()).toEqual([1, 8]);
    // Team 20 mirror image.
    expect(rosterAtOrdinal([4], 20, ledger, 4)).toEqual([8]);
    expect(rosterAtOrdinal([4], 20, ledger, 5)).toEqual([4]);
  });

  it("ignores movements for other teams", () => {
    const ledger = [row("ADD", 9, null, 99, 3), row("DROP", 6, 98, null, 3)];
    expect(rosterAtOrdinal([1], 10, ledger, 1)).toEqual([1]);
  });
});

describe("everRosteredPlayerIds", () => {
  it("unions current ids with every ledger appearance for the team", () => {
    const ledger = [
      row("DROP", 5, 10, null, 2),
      row("ADD", 9, null, 10, 2),
      row("ADD", 77, null, 99, 2), // other team - excluded
    ];
    expect(everRosteredPlayerIds([1, 9], 10, ledger).sort((a, b) => a - b)).toEqual([
      1, 5, 9,
    ]);
  });
});
