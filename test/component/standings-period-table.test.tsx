// @vitest-environment jsdom
/**
 * StandingsPeriodTable — the per-period best-ball breakdown grid.
 *
 * Behaviour under test:
 *   - each scored (team, period) cell is a button; clicking it opens an overlay
 *     revealing exactly that team's XI for that period (sorted by points);
 *   - a period with no XI renders plain text, not a button;
 *   - the overlay closes on Escape and on a backdrop click;
 *   - clicking a player in the overlay lazily fetches and shows their per-rule
 *     breakdown for the period (fetch is mocked).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "./setup";

// next/link needs a Next runtime/app context; render a plain anchor instead.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

import type { PlayerBreakdown } from "../../src/data/standings/player-breakdown";
import StandingsPeriodTable, {
  type PeriodTableRow,
} from "../../app/leagues/[leagueId]/standings/standings-period-table";

const stages = ["GROUP_1", "FINAL"];
const stageLabel = { GROUP_1: "MD1", FINAL: "Final" };
const stageFull = { GROUP_1: "Group Stage MD1", FINAL: "Final" };

function rows(): PeriodTableRow[] {
  return [
    {
      fantasyTeamId: 10,
      teamName: "Team Alpha",
      total: 50,
      periods: [
        {
          stage: "GROUP_1",
          formation: "4-3-3",
          points: 50,
          xi: [
            { playerId: 101, fullName: "Anna Alpha", position: "FWD", points: 12 },
            { playerId: 102, fullName: "Bert Alpha", position: "MID", points: 8 },
          ],
        },
        // No XI for the Final: should render as plain text, not a button.
        { stage: "FINAL", formation: "-", points: 0, xi: [] },
      ],
    },
    {
      fantasyTeamId: 20,
      teamName: "Team Beta",
      total: 40,
      periods: [
        {
          stage: "GROUP_1",
          formation: "4-4-2",
          points: 40,
          xi: [{ playerId: 201, fullName: "Cara Beta", position: "DEF", points: 9 }],
        },
        { stage: "FINAL", formation: "-", points: 0, xi: [] },
      ],
    },
  ];
}

function renderTable() {
  return render(
    <StandingsPeriodTable
      leagueId={7}
      stages={stages}
      stageLabel={stageLabel}
      stageFull={stageFull}
      rows={rows()}
    />,
  );
}

/** Click Team Alpha's MD1 (GROUP_1) cell, which has the only XI in that row. */
async function openAlphaMd1(user: ReturnType<typeof userEvent.setup>) {
  const row = screen.getByText("Team Alpha").closest("tr") as HTMLTableRowElement;
  const cellBtn = within(row).getByRole("button"); // only the scored GROUP_1 cell
  await user.click(cellBtn);
  return screen.getByRole("dialog");
}

describe("StandingsPeriodTable", () => {
  it("renders a button only for periods that have an XI", () => {
    renderTable();
    const alphaRow = screen.getByText("Team Alpha").closest("tr") as HTMLTableRowElement;
    // GROUP_1 has an XI (button); FINAL has none (no button, just the points).
    expect(within(alphaRow).getAllByRole("button")).toHaveLength(1);
  });

  it("opens an overlay revealing that team's XI for the period", async () => {
    const user = userEvent.setup();
    renderTable();
    const dialog = await openAlphaMd1(user);

    // Header identifies the team + period + formation.
    expect(within(dialog).getByText(/Group Stage MD1/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Team Alpha/)).toBeInTheDocument();

    // Alpha's two XI players are shown; Beta's player is not.
    expect(within(dialog).getByText("Anna Alpha")).toBeInTheDocument();
    expect(within(dialog).getByText("Bert Alpha")).toBeInTheDocument();
    expect(within(dialog).queryByText("Cara Beta")).not.toBeInTheDocument();
  });

  it("shows the XI sorted by points descending", async () => {
    const user = userEvent.setup();
    renderTable();
    const dialog = await openAlphaMd1(user);
    const names = within(dialog)
      .getAllByText(/Alpha$/)
      .map((el) => el.textContent?.replace(/^[▸▾]\s*/, "").trim());
    // Anna (12 pts) before Bert (8 pts).
    expect(names).toEqual(["Anna Alpha", "Bert Alpha"]);
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    renderTable();
    await openAlphaMd1(user);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on a backdrop click", async () => {
    const user = userEvent.setup();
    const { container } = renderTable();
    await openAlphaMd1(user);
    const backdrop = container.querySelector(".xi-overlay") as HTMLElement;
    fireEvent.click(backdrop);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("StandingsPeriodTable player breakdown", () => {
  const breakdown: PlayerBreakdown = {
    playerId: 101,
    fullName: "Anna Alpha",
    position: "FWD",
    rulesetVersion: "wcf-test",
    ownership: { ownedCount: 1, ownershipPct: 0.5, totalFantasyTeams: 2 },
    adp: 4,
    fixtures: [
      {
        fixtureId: 900,
        stage: "GROUP_1",
        opponent: "vs Mexico",
        kickoffUtc: "2026-06-12T00:00:00Z",
        total: 12,
        rules: [
          { key: "goals", label: "Goals", count: 2, points: 8 },
          { key: "appearance", label: "Appearance", count: null, points: 2 },
        ],
      },
    ],
  };

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true, data: breakdown }),
      })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches and renders a player's per-rule breakdown for the period", async () => {
    const user = userEvent.setup();
    renderTable();
    const dialog = await openAlphaMd1(user);

    await user.click(within(dialog).getByRole("button", { name: /Anna Alpha/ }));

    // Hit the breakdown endpoint for the right league + player.
    expect(fetch).toHaveBeenCalledWith("/api/leagues/7/players/101/breakdown");

    // The fetched rules appear (await the async state update).
    expect(await within(dialog).findByText("vs Mexico")).toBeInTheDocument();
    expect(within(dialog).getByText("Goals")).toBeInTheDocument();
    expect(within(dialog).getByText("Appearance")).toBeInTheDocument();
  });
});
