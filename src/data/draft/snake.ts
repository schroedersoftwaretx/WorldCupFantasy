/**
 * Snake-draft order math (pure).
 *
 * A snake draft of N managers over R rounds visits managers in order
 * 1..N on odd rounds and N..1 on even rounds, so the manager who picks
 * last in one round picks first in the next. With overall picks numbered
 * 1..(N*R):
 *
 *   round 1:  slot 1, 2, 3, ... N
 *   round 2:  slot N, ... 3, 2, 1
 *   round 3:  slot 1, 2, 3, ... N
 *   ...
 *
 * "slot" here is the 1-based position in the round-1 order (the draft_order
 * table). Everything in this file is pure - no DB, no I/O - so the engine
 * and the tests share the exact same arithmetic.
 */

/** 1-based round number for a 1-based overall pick. */
export function roundForPick(pickNumber: number, managerCount: number): number {
  assertPositiveInt(pickNumber, "pickNumber");
  assertPositiveInt(managerCount, "managerCount");
  return Math.floor((pickNumber - 1) / managerCount) + 1;
}

/**
 * 1-based draft-order slot that is on the clock for a 1-based overall pick.
 *
 * Odd rounds run the order forwards (slot 1..N); even rounds run it
 * backwards (slot N..1) - that reversal is the "snake".
 */
export function slotForPick(pickNumber: number, managerCount: number): number {
  assertPositiveInt(pickNumber, "pickNumber");
  assertPositiveInt(managerCount, "managerCount");
  const round = roundForPick(pickNumber, managerCount);
  const indexInRound = (pickNumber - 1) % managerCount; // 0-based
  const forward = indexInRound + 1; // 1-based
  return round % 2 === 1 ? forward : managerCount - indexInRound;
}

/**
 * The full pick sequence as 1-based slots, one entry per overall pick.
 * Length is managerCount * rounds. Handy for tests and for previewing a
 * draft board.
 */
export function generateSnakeSequence(
  managerCount: number,
  rounds: number,
): number[] {
  assertPositiveInt(managerCount, "managerCount");
  assertPositiveInt(rounds, "rounds");
  const total = managerCount * rounds;
  const seq: number[] = [];
  for (let pick = 1; pick <= total; pick += 1) {
    seq.push(slotForPick(pick, managerCount));
  }
  return seq;
}

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
}
