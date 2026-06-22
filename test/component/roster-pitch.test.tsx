// @vitest-environment jsdom
/**
 * RosterPitch — the per-week pitch + stats table on the roster page.
 *
 * Behaviour under test (what a manager sees):
 *   - a week chip exists for every period that has a result, plus an "All" chip;
 *   - clicking a chip switches the stats table to that period's goals / assists /
 *     points;
 *   - rows that belong to the best-ball XI are highlighted (row-has-xi) and the
 *     tfoot totals sum ONLY those XI rows (a benched player is excluded);
 *   - the "All" chip shows season-long totals across every period.
 *
 * The fixture is hand-built so the best-ball optimiser has exactly one legal
 * answer: 1 GK + 4 DEF + 3 MID + 4 FWD available forces a 4-3-3 (FWD caps at 3),
 * dropping the lone low-scoring forward ("Benny Bench") from the XI.
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "./setup";

import type { RosterPlayerScore } from "../../src/web/api-types";
import { RosterPitch } from "../../app/leagues/[leagueId]/roster/[teamId]/roster-pitch";

interface Line {
  id: number;
  name: string;
  pos: "GK" | "DEF" | "MID" | "FWD";
  md1: { p: number; g: number; a: number };
  md2: { p: number; g: number; a: number };
}

// 12 players: a clean 4-3-3 core (11) plus a benched forward. The benched
// forward scores least in every period, so it is never in the best-ball XI.
const LINES: Line[] = [
  { id: 1, name: "Gabriel Keeper", pos: "GK", md1: { p: 4, g: 0, a: 0 }, md2: { p: 2, g: 0, a: 0 } },
  { id: 2, name: "Dan Defone", pos: "DEF", md1: { p: 7, g: 1, a: 0 }, md2: { p: 3, g: 0, a: 1 } },
  { id: 3, name: "Dan Deftwo", pos: "DEF", md1: { p: 6, g: 0, a: 1 }, md2: { p: 3, g: 1, a: 0 } },
  { id: 4, name: "Dan Defthree", pos: "DEF", md1: { p: 6, g: 0, a: 0 }, md2: { p: 2, g: 0, a: 0 } },
  { id: 5, name: "Dan Deffour", pos: "DEF", md1: { p: 5, g: 0, a: 0 }, md2: { p: 2, g: 0, a: 0 } },
  { id: 6, name: "Mike Midone", pos: "MID", md1: { p: 9, g: 2, a: 1 }, md2: { p: 5, g: 1, a: 0 } },
  { id: 7, name: "Mike Midtwo", pos: "MID", md1: { p: 8, g: 1, a: 0 }, md2: { p: 4, g: 0, a: 1 } },
  { id: 8, name: "Mike Midthree", pos: "MID", md1: { p: 7, g: 1, a: 1 }, md2: { p: 4, g: 1, a: 0 } },
  { id: 9, name: "Frank Fwdone", pos: "FWD", md1: { p: 12, g: 3, a: 0 }, md2: { p: 6, g: 1, a: 0 } },
  { id: 10, name: "Frank Fwdtwo", pos: "FWD", md1: { p: 10, g: 2, a: 1 }, md2: { p: 5, g: 0, a: 1 } },
  { id: 11, name: "Frank Fwdthree", pos: "FWD", md1: { p: 9, g: 2, a: 0 }, md2: { p: 4, g: 1, a: 0 } },
  { id: 12, name: "Benny Bench", pos: "FWD", md1: { p: 1, g: 0, a: 0 }, md2: { p: 0, g: 0, a: 0 } },
];

function makePlayers(): RosterPlayerScore[] {
  return LINES.map((l) => ({
    playerId: l.id,
    fullName: l.name,
    position: l.pos,
    nationalTeam: "Testland",
    eliminated: false,
    totalPoints: l.md1.p + l.md2.p,
    periods: [
      { stage: "GROUP_1", points: l.md1.p, goals: l.md1.g, assists: l.md1.a, inXi: true, appeared: true },
      { stage: "GROUP_2", points: l.md2.p, goals: l.md2.g, assists: l.md2.a, inXi: true, appeared: true },
    ],
  }));
}

/** Read the [name, pos, G, A, Pts] cells of the table row containing `name`. */
function rowCells(name: string): string[] {
  const row = screen.getByText(name).closest("tr") as HTMLTableRowElement;
  return within(row)
    .getAllByRole("cell")
    .map((c) => c.textContent ?? "");
}

/** Read the tfoot "Best-ball XI total" row's [label, G, A, Pts]. */
function footerCells(): string[] {
  const row = screen.getByText("Best-ball XI total").closest("tr") as HTMLTableRowElement;
  return within(row)
    .getAllByRole("cell")
    .map((c) => c.textContent ?? "");
}

describe("RosterPitch", () => {
  it("shows a chip for every played week plus an All chip", () => {
    render(<RosterPitch players={makePlayers()} />);
    expect(screen.getByRole("button", { name: "MD1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "MD2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    // A stage with no results (e.g. Final) gets no chip.
    expect(screen.queryByRole("button", { name: "Final" })).not.toBeInTheDocument();
  });

  it("defaults to the most recent played week (MD2)", () => {
    render(<RosterPitch players={makePlayers()} />);
    expect(screen.getByRole("button", { name: "MD2" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "MD1" })).toHaveAttribute("aria-pressed", "false");
    // MD2 stat line for the top forward: 6 pts, 1 goal, 0 assists.
    expect(rowCells("Frank Fwdone")).toEqual(["Frank Fwdone", "FWD", "1", "0", "6"]);
  });

  it("switches the stats table when another week chip is clicked", async () => {
    const user = userEvent.setup();
    render(<RosterPitch players={makePlayers()} />);

    await user.click(screen.getByRole("button", { name: "MD1" }));

    expect(screen.getByRole("button", { name: "MD1" })).toHaveAttribute("aria-pressed", "true");
    // MD1 stat line for the top forward: 12 pts, 3 goals, 0 assists.
    expect(rowCells("Frank Fwdone")).toEqual(["Frank Fwdone", "FWD", "3", "0", "12"]);
  });

  it("highlights best-ball-XI rows and excludes the benched player", async () => {
    const user = userEvent.setup();
    render(<RosterPitch players={makePlayers()} />);
    await user.click(screen.getByRole("button", { name: "MD1" }));

    const xiRow = screen.getByText("Frank Fwdone").closest("tr") as HTMLTableRowElement;
    const benchRow = screen.getByText("Benny Bench").closest("tr") as HTMLTableRowElement;

    expect(xiRow).toHaveClass("row-has-xi");
    expect(benchRow).not.toHaveClass("row-has-xi");
  });

  it("tfoot totals sum only the XI rows (benched forward excluded)", async () => {
    const user = userEvent.setup();
    render(<RosterPitch players={makePlayers()} />);
    await user.click(screen.getByRole("button", { name: "MD1" }));

    // XI = GK(4) + 4 DEF + 3 MID + 3 best FWD; Benny (1pt) is dropped.
    // goals 12, assists 4, points 83 — Benny contributes 0/0/1 and is excluded.
    expect(footerCells()).toEqual(["Best-ball XI total", "12", "4", "83"]);
  });

  it("the All chip shows season totals across every period", async () => {
    const user = userEvent.setup();
    render(<RosterPitch players={makePlayers()} />);
    await user.click(screen.getByRole("button", { name: "All" }));

    expect(screen.getByText("Best XI — whole tournament")).toBeInTheDocument();
    // Frank Fwdone season totals: goals 3+1, assists 0+0, points 12+6.
    expect(rowCells("Frank Fwdone")).toEqual(["Frank Fwdone", "FWD", "4", "0", "18"]);
    // Season XI totals: goals 12+5, assists 4+3, points 83+40.
    expect(footerCells()).toEqual(["Best-ball XI total", "17", "7", "123"]);
  });

  it("renders an empty-state hint before any week has a result", () => {
    const players = makePlayers().map((p) => ({
      ...p,
      periods: p.periods.map((pd) => ({ ...pd, appeared: false })),
    }));
    render(<RosterPitch players={players} />);
    expect(screen.getByText(/No matches scored yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "MD1" })).not.toBeInTheDocument();
  });
});
