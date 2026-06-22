// @vitest-environment jsdom
/**
 * DraftTrendsTable — sortable + filterable ADP / ownership / reach table.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "./setup";

import type { DraftTrendRow } from "../../src/data/stats/hub";
import { DraftTrendsTable } from "../../app/stats/draft-trends/trends-table";

const NAMES = ["Ada Striker", "Ben Mid", "Cy Back"];

function rows(): DraftTrendRow[] {
  return [
    {
      playerId: 1, fullName: "Ada Striker", position: "FWD", nationalTeamId: 1,
      nationalTeamName: "Brazil", adp: 2.5, earliestPick: 1, latestPick: 6,
      timesPicked: 10, takeRate: 0.9, draftRank: 1, reachSteal: 1.5,
      ownedCount: 9, ownershipPct: 0.9,
    },
    {
      playerId: 2, fullName: "Ben Mid", position: "MID", nationalTeamId: 2,
      nationalTeamName: "Argentina", adp: 1.2, earliestPick: 1, latestPick: 3,
      timesPicked: 10, takeRate: 1.0, draftRank: 4, reachSteal: -2.8,
      ownedCount: 10, ownershipPct: 1.0,
    },
    {
      playerId: 3, fullName: "Cy Back", position: "DEF", nationalTeamId: 1,
      nationalTeamName: "Brazil", adp: 8.0, earliestPick: 5, latestPick: 12,
      timesPicked: 5, takeRate: 0.5, draftRank: 6, reachSteal: 2.0,
      ownedCount: 5, ownershipPct: 0.5,
    },
  ];
}

function order(): string[] {
  return Array.from(document.querySelectorAll("tbody tr")).map(
    (r) => NAMES.find((n) => r.textContent?.includes(n)) ?? "?",
  );
}

describe("DraftTrendsTable", () => {
  it("defaults to ADP ascending", () => {
    render(<DraftTrendsTable rows={rows()} totalDrafts={10} totalFantasyTeams={10} />);
    expect(order()).toEqual(["Ben Mid", "Ada Striker", "Cy Back"]);
  });

  it("sorts by name, ownership and reach/steal", async () => {
    const user = userEvent.setup();
    render(<DraftTrendsTable rows={rows()} totalDrafts={10} totalFantasyTeams={10} />);

    await user.click(screen.getByRole("button", { name: /Player/ }));
    expect(order()).toEqual(["Ada Striker", "Ben Mid", "Cy Back"]);

    await user.click(screen.getByRole("button", { name: /Owned%/ }));
    expect(order()).toEqual(["Ben Mid", "Ada Striker", "Cy Back"]); // 1.0, 0.9, 0.5

    // Biggest reach (most negative) first.
    await user.click(screen.getByRole("button", { name: /Reach\/Steal/ }));
    expect(order()).toEqual(["Ben Mid", "Ada Striker", "Cy Back"]); // -2.8, 1.5, 2.0
  });

  it("filters by position and nation", async () => {
    const user = userEvent.setup();
    render(<DraftTrendsTable rows={rows()} totalDrafts={10} totalFantasyTeams={10} />);

    await user.selectOptions(screen.getByLabelText("Filter by position"), "DEF");
    expect(order()).toEqual(["Cy Back"]);

    await user.selectOptions(screen.getByLabelText("Filter by position"), "ALL");
    await user.selectOptions(screen.getByLabelText("Filter by nation"), "Argentina");
    expect(order()).toEqual(["Ben Mid"]);
  });

  it("shows an empty state when filters exclude everyone", async () => {
    const user = userEvent.setup();
    render(<DraftTrendsTable rows={rows()} totalDrafts={10} totalFantasyTeams={10} />);
    await user.selectOptions(screen.getByLabelText("Filter by position"), "GK");
    expect(screen.getByText("No players match those filters.")).toBeInTheDocument();
  });
});
