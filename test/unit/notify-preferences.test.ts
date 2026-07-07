/**
 * Unit tests for the pure channel-filtering logic behind notification
 * preferences. No DB: covers the opt-out default, suppression of an opted-out
 * (category, channel), and the pass-through for unmanaged notification types.
 */
import { describe, expect, it } from "vitest";

import {
  applyPreferences,
  disabledSetFromRows,
  isNotificationCategory,
  NOTIFICATION_CATEGORIES,
} from "../../src/data/notify/preferences.js";
import type { NotificationChannel } from "../../src/data/db/schema.js";

const BOTH: NotificationChannel[] = ["IN_APP", "EMAIL"];

describe("isNotificationCategory", () => {
  it("recognizes the existing draft categories only", () => {
    expect(isNotificationCategory("ON_THE_CLOCK")).toBe(true);
    expect(isNotificationCategory("DRAFT_STARTED")).toBe(true);
    // Not a category — must never be invented for unbuilt features.
    expect(isNotificationCategory("GOAL_ALERT")).toBe(false);
    expect(isNotificationCategory("CHAT_MENTION")).toBe(false);
  });

  it("covers exactly the five draft lifecycle types", () => {
    expect([...NOTIFICATION_CATEGORIES]).toEqual([
      "DRAFT_STARTED",
      "ON_THE_CLOCK",
      "PICK_MADE",
      "AUTOPICK_MADE",
      "DRAFT_COMPLETE",
    ]);
  });
});

describe("applyPreferences", () => {
  it("with no stored prefs, both channels pass (opt-out default)", () => {
    const disabled = disabledSetFromRows([]);
    expect(applyPreferences("ON_THE_CLOCK", BOTH, disabled)).toEqual([
      "IN_APP",
      "EMAIL",
    ]);
  });

  it("suppresses an opted-out (category, channel)", () => {
    const disabled = disabledSetFromRows([
      { category: "ON_THE_CLOCK", channel: "EMAIL", enabled: false },
    ]);
    expect(applyPreferences("ON_THE_CLOCK", BOTH, disabled)).toEqual(["IN_APP"]);
  });

  it("a fully opted-out category yields no channels", () => {
    const disabled = disabledSetFromRows([
      { category: "PICK_MADE", channel: "IN_APP", enabled: false },
      { category: "PICK_MADE", channel: "EMAIL", enabled: false },
    ]);
    expect(applyPreferences("PICK_MADE", BOTH, disabled)).toEqual([]);
  });

  it("opt-out is scoped to its own category", () => {
    const disabled = disabledSetFromRows([
      { category: "PICK_MADE", channel: "EMAIL", enabled: false },
    ]);
    // A different category is unaffected.
    expect(applyPreferences("ON_THE_CLOCK", BOTH, disabled)).toEqual([
      "IN_APP",
      "EMAIL",
    ]);
  });

  it("enabled=true rows do not disable anything", () => {
    const disabled = disabledSetFromRows([
      { category: "ON_THE_CLOCK", channel: "EMAIL", enabled: true },
    ]);
    expect(applyPreferences("ON_THE_CLOCK", BOTH, disabled)).toEqual([
      "IN_APP",
      "EMAIL",
    ]);
  });

  it("unmanaged types are never filtered, even with a matching key", () => {
    const disabled = disabledSetFromRows([
      { category: "GOAL_ALERT", channel: "EMAIL", enabled: false },
    ]);
    // Unknown type → pass through unchanged.
    expect(applyPreferences("GOAL_ALERT", BOTH, disabled)).toEqual([
      "IN_APP",
      "EMAIL",
    ]);
  });
});
