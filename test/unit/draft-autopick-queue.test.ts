/**
 * Unit tests for the queue-aware autopick (pure). Verifies the full fallback
 * chain the phase requires:
 *   queued + available + legal (highest rank) → else draft_rank.
 */
import { describe, expect, it } from "vitest";

import type { Position } from "../../src/data/db/schema.js";
import {
  chooseAutopick,
  selectQueuedCandidate,
  type AutopickCandidate,
} from "../../src/data/draft/autopick.js";
import type { PositionCounts } from "../../src/data/roster/validator.js";

function cand(
  playerId: number,
  position: Position,
  draftRank: number | null,
): AutopickCandidate {
  return { playerId, position, draftRank, fullName: `Player ${playerId}` };
}

function counts(gk: number, def: number, mid: number, fwd: number): PositionCounts {
  return { GK: gk, DEF: def, MID: mid, FWD: fwd };
}

describe("selectQueuedCandidate", () => {
  it("returns null for an empty queue", () => {
    expect(selectQueuedCandidate([cand(1, "FWD", 1)], [])).toBeNull();
  });

  it("takes the first queued id that is in the legal pool", () => {
    const legal = [cand(1, "FWD", 9), cand(2, "MID", 9), cand(3, "DEF", 9)];
    // Queue priority: 2 then 3 then 1.
    expect(selectQueuedCandidate(legal, [2, 3, 1])?.playerId).toBe(2);
  });

  it("skips queued players that aren't in the legal pool (taken/illegal)", () => {
    const legal = [cand(3, "DEF", 9)];
    // 2 was the top target but isn't available/legal; fall through to 3.
    expect(selectQueuedCandidate(legal, [2, 3])?.playerId).toBe(3);
  });
});

describe("chooseAutopick with a queue", () => {
  it("prefers the highest-priority queued, available, legal player over draft_rank", () => {
    const pool = [
      cand(10, "FWD", 1), // best by draft_rank
      cand(20, "MID", 50),
      cand(30, "DEF", 80),
    ];
    // Queue ranks 30 first. Even though 10 is rank 1, the queue wins.
    const r = chooseAutopick(counts(0, 0, 0, 0), pool, undefined, [30, 20]);
    expect(r.pick?.playerId).toBe(30);
    expect(r.fromQueue).toBe(true);
  });

  it("falls back to draft_rank when the queue is empty", () => {
    const pool = [cand(10, "FWD", 3), cand(11, "MID", 1), cand(12, "DEF", 2)];
    const r = chooseAutopick(counts(0, 0, 0, 0), pool, undefined, []);
    expect(r.pick?.playerId).toBe(11); // rank 1
    expect(r.fromQueue).toBe(false);
  });

  it("falls back to draft_rank when no queued player is still available", () => {
    // Queue references 99, which isn't in the available pool at all.
    const pool = [cand(10, "FWD", 3), cand(11, "MID", 1)];
    const r = chooseAutopick(counts(0, 0, 0, 0), pool, undefined, [99]);
    expect(r.pick?.playerId).toBe(11);
    expect(r.fromQueue).toBe(false);
  });

  it("skips a queued player whose position is now ILLEGAL, then falls back", () => {
    // GK at cap (4): the queued GK is illegal. Queue has only that GK, so we
    // fall back to draft_rank over the remaining legal pool.
    const pool = [cand(1, "GK", 1), cand(2, "DEF", 7), cand(3, "MID", 4)];
    const r = chooseAutopick(counts(4, 6, 5, 3), pool, undefined, [1]);
    expect(r.pick?.position).not.toBe("GK");
    expect(r.pick?.playerId).toBe(3); // rank 4 beats rank 7
    expect(r.fromQueue).toBe(false);
  });

  it("walks the queue in priority order, taking the first legal one", () => {
    // GK at cap: queued [1 (GK, illegal), 2 (DEF, legal)] → takes 2 from queue.
    const pool = [cand(1, "GK", 1), cand(2, "DEF", 70), cand(3, "MID", 2)];
    const r = chooseAutopick(counts(4, 6, 5, 3), pool, undefined, [1, 2]);
    expect(r.pick?.playerId).toBe(2);
    expect(r.fromQueue).toBe(true);
  });

  it("a queued pick still respects roster-completability (never strands the roster)", () => {
    // 0/8/8/5 = 21 picks, 2 left, GK needs 2. Queue wants a 6th FWD (under cap
    // but would strand the roster) → illegal → fall back to the forced GK.
    const pool = [cand(1, "FWD", 1), cand(2, "GK", 99)];
    const r = chooseAutopick(counts(0, 8, 8, 5), pool, undefined, [1]);
    expect(r.pick?.position).toBe("GK");
    expect(r.fromQueue).toBe(false);
  });

  it("returns a null pick when nothing is legal, queue or not", () => {
    const r = chooseAutopick(counts(4, 8, 7, 4), [cand(1, "DEF", 1)], undefined, [1]);
    expect(r.pick).toBeNull();
    expect(r.fromQueue).toBe(false);
  });
});
