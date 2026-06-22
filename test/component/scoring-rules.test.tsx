// @vitest-environment jsdom
/**
 * ScoringRules — the collapsible scoring-sheet panel (native <details>).
 *
 * Behaviour under test:
 *   - the rule rows render the point values from the supplied ruleset;
 *   - the panel is collapsed by default and toggles open/closed via its
 *     <summary>.
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "./setup";

import { DEFAULT_RULESET } from "../../src/data/scoring/ruleset";
import { ScoringRules } from "../../app/leagues/[leagueId]/draft/scoring-rules";

/** Mirror the component's signed display: +1 / −2 (unicode minus). */
function fmt(n: number): string {
  return `${n >= 0 ? "+" : "−"}${Math.abs(n)}`;
}

/** The points cell of the row whose label cell contains `label`. */
function pointsFor(label: string): string {
  const row = screen.getByText(label).closest("tr") as HTMLTableRowElement;
  const cells = within(row).getAllByRole("cell");
  return cells[cells.length - 1]?.textContent ?? "";
}

describe("ScoringRules", () => {
  it("renders rule rows with the ruleset's point values", () => {
    render(<ScoringRules ruleset={DEFAULT_RULESET} />);
    expect(pointsFor("Appearance (played any minutes)")).toBe(fmt(DEFAULT_RULESET.appearance));
    expect(pointsFor("Assist (any position)")).toBe(fmt(DEFAULT_RULESET.assist));
    expect(pointsFor("Goal — FWD")).toBe(fmt(DEFAULT_RULESET.goalByPosition.FWD));
    expect(pointsFor("Yellow card")).toBe(fmt(DEFAULT_RULESET.yellowCard));
  });

  it("is collapsed by default and toggles open/closed via the summary", async () => {
    const user = userEvent.setup();
    const { container } = render(<ScoringRules ruleset={DEFAULT_RULESET} />);
    const details = container.querySelector("details") as HTMLDetailsElement;
    const summary = within(details).getByText("Scoring rules");

    expect(details.open).toBe(false);
    await user.click(summary);
    expect(details.open).toBe(true);
    await user.click(summary);
    expect(details.open).toBe(false);
  });
});
