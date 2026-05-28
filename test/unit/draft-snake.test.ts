/**
 * Unit tests for the pure snake-order math.
 */
import { describe, expect, it } from "vitest";

import {
  generateSnakeSequence,
  roundForPick,
  slotForPick,
} from "../../src/data/draft/snake.js";

describe("roundForPick", () => {
  it("maps pick numbers to 1-based rounds", () => {
    // 3 managers: picks 1-3 round 1, 4-6 round 2, 7-9 round 3.
    expect(roundForPick(1, 3)).toBe(1);
    expect(roundForPick(3, 3)).toBe(1);
    expect(roundForPick(4, 3)).toBe(2);
    expect(roundForPick(6, 3)).toBe(2);
    expect(roundForPick(7, 3)).toBe(3);
  });
});

describe("slotForPick", () => {
  it("runs round 1 forwards", () => {
    expect(slotForPick(1, 3)).toBe(1);
    expect(slotForPick(2, 3)).toBe(2);
    expect(slotForPick(3, 3)).toBe(3);
  });

  it("runs round 2 backwards (the snake reversal)", () => {
    expect(slotForPick(4, 3)).toBe(3);
    expect(slotForPick(5, 3)).toBe(2);
    expect(slotForPick(6, 3)).toBe(1);
  });

  it("runs round 3 forwards again", () => {
    expect(slotForPick(7, 3)).toBe(1);
    expect(slotForPick(8, 3)).toBe(2);
    expect(slotForPick(9, 3)).toBe(3);
  });

  it("the last picker of one round picks first in the next", () => {
    // 4 managers: pick 4 (slot 4) then pick 5 (slot 4 again).
    expect(slotForPick(4, 4)).toBe(4);
    expect(slotForPick(5, 4)).toBe(4);
    // ... and the first picker of round 1 picks last in round 2.
    expect(slotForPick(1, 4)).toBe(1);
    expect(slotForPick(8, 4)).toBe(1);
  });
});

describe("generateSnakeSequence", () => {
  it("produces the full board for 3 managers x 3 rounds", () => {
    expect(generateSnakeSequence(3, 3)).toEqual([1, 2, 3, 3, 2, 1, 1, 2, 3]);
  });

  it("every slot appears exactly `rounds` times", () => {
    const managers = 8;
    const rounds = 23;
    const seq = generateSnakeSequence(managers, rounds);
    expect(seq).toHaveLength(managers * rounds);
    const tally = new Map<number, number>();
    for (const slot of seq) tally.set(slot, (tally.get(slot) ?? 0) + 1);
    for (let slot = 1; slot <= managers; slot += 1) {
      expect(tally.get(slot)).toBe(rounds);
    }
  });

  it("each manager's picks are evenly spaced (snake fairness)", () => {
    // For a snake draft, consecutive picks for the slot at an end of the
    // order are back-to-back at the turn; the gap pattern is N-1, N+1, ...
    const managers = 4;
    const seq = generateSnakeSequence(managers, 6); // 24 picks
    // overall pick numbers (1-based) for slot 1:
    const slot1Picks: number[] = [];
    seq.forEach((slot, idx) => {
      if (slot === 1) slot1Picks.push(idx + 1);
    });
    // round 1 pick 1, round 2 pick 8, round 3 pick 9, ...
    expect(slot1Picks).toEqual([1, 8, 9, 16, 17, 24]);
  });

  it("rejects non-positive inputs", () => {
    expect(() => generateSnakeSequence(0, 3)).toThrow();
    expect(() => slotForPick(0, 3)).toThrow();
    expect(() => roundForPick(1, 0)).toThrow();
  });
});
