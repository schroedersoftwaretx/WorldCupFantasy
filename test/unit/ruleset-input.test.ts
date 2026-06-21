/**
 * Unit tests for sanitizeRulesetInput — the untrusted-payload validator behind
 * the owner-only "edit league scoring" API.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RULESET,
  RulesetValidationError,
  buildRuleset,
  sanitizeRulesetInput,
} from "../../src/data/scoring/ruleset.js";

/** A structurally complete, valid payload (plain JSON, like a request body). */
function base(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(DEFAULT_RULESET));
}

describe("sanitizeRulesetInput", () => {
  it("accepts a complete payload and round-trips to the default version", () => {
    const values = sanitizeRulesetInput(base());
    expect(buildRuleset(values).version).toBe(DEFAULT_RULESET.version);
  });

  it("re-versions when a value changes", () => {
    const values = sanitizeRulesetInput({ ...base(), bigChanceCreated: 3 });
    expect(values.bigChanceCreated).toBe(3);
    expect(buildRuleset(values).version).not.toBe(DEFAULT_RULESET.version);
  });

  it("rounds point values to 2dp (engine round2 invariant)", () => {
    const values = sanitizeRulesetInput({ ...base(), passCompleted: 0.054321 });
    expect(values.passCompleted).toBe(0.05);
  });

  it("fixes cleanSheetByPosition to GK + DEF and ignores other positions", () => {
    const values = sanitizeRulesetInput({
      ...base(),
      cleanSheetByPosition: { GK: 4, DEF: 6, MID: 9 },
    });
    expect(values.cleanSheetByPosition).toEqual({ GK: 4, DEF: 6 });
  });

  it("rejects a non-numeric point value", () => {
    expect(() => sanitizeRulesetInput({ ...base(), assist: "lots" })).toThrow(
      RulesetValidationError,
    );
  });

  it("rejects an out-of-range value", () => {
    expect(() =>
      sanitizeRulesetInput({
        ...base(),
        goalByPosition: { GK: 999, DEF: 7, MID: 6, FWD: 5 },
      }),
    ).toThrow(RulesetValidationError);
  });

  it("rejects a non-integer clean-sheet minute threshold", () => {
    expect(() =>
      sanitizeRulesetInput({ ...base(), cleanSheetMinMinutes: 59.5 }),
    ).toThrow(RulesetValidationError);
  });

  it("rejects a missing nested map", () => {
    const b = base();
    delete b["goalByPosition"];
    expect(() => sanitizeRulesetInput(b)).toThrow(RulesetValidationError);
  });

  it("rejects a non-object payload", () => {
    expect(() => sanitizeRulesetInput(null)).toThrow(RulesetValidationError);
    expect(() => sanitizeRulesetInput([1, 2, 3])).toThrow(RulesetValidationError);
  });
});
