// @vitest-environment jsdom
/**
 * PlayerBoard — the draft-room available-player board.
 *
 * Behaviour under test:
 *   - clicking a column header re-sorts the visible rows by that column;
 *   - the search box and the position / team selects filter the rows;
 *   - the "Draft" button is enabled only when it is the viewer's pick AND the
 *     player is a legal addition AND the board is not busy.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "./setup";

import type { DraftBoardPlayer } from "../../src/web/api-types";
import PlayerBoard from "../../app/leagues/[leagueId]/draft/player-board";

const NAMES = ["Alice Anderson", "Bob Baker", "Carol Clark", "Dave Davis"];

function players(): DraftBoardPlayer[] {
  return [
    {
      id: 1, fullName: "Alice Anderson", position: "FWD", nationalTeam: "Brazil",
      draftRank: 3, projectedTotalPoints: 50.5, adp: 5,
      stageProbabilities: { CHAMPION: 0.2 }, legal: true,
    },
    {
      id: 2, fullName: "Bob Baker", position: "MID", nationalTeam: "Argentina",
      draftRank: 1, projectedTotalPoints: 30.2, adp: 2,
      stageProbabilities: { CHAMPION: 0.5 }, legal: false,
    },
    {
      id: 3, fullName: "Carol Clark", position: "DEF", nationalTeam: "Brazil",
      draftRank: 2, projectedTotalPoints: 40.0, adp: 8,
      stageProbabilities: { CHAMPION: 0.4 }, legal: true,
    },
    {
      id: 4, fullName: "Dave Davis", position: "GK", nationalTeam: "Argentina",
      draftRank: null, projectedTotalPoints: null, adp: null,
      stageProbabilities: null, legal: true,
    },
  ];
}

/** The visible player names, in table order. */
function order(): string[] {
  return Array.from(document.querySelectorAll("tbody tr")).map(
    (r) => NAMES.find((n) => r.textContent?.includes(n)) ?? "?",
  );
}

/** The Draft button inside the row for `name`. */
function draftBtn(name: string): HTMLButtonElement {
  const row = screen.getByText(name).closest("tr") as HTMLTableRowElement;
  return within(row).getByRole("button", { name: "Draft" }) as HTMLButtonElement;
}

function noop() {}

describe("PlayerBoard sorting", () => {
  it("defaults to projected-points descending", () => {
    render(<PlayerBoard players={players()} canDraft={false} busy={false} onDraft={noop} />);
    expect(order()).toEqual(["Alice Anderson", "Carol Clark", "Bob Baker", "Dave Davis"]);
  });

  it("sorts by rank ascending (unranked last)", async () => {
    const user = userEvent.setup();
    render(<PlayerBoard players={players()} canDraft={false} busy={false} onDraft={noop} />);
    await user.click(screen.getByRole("button", { name: /Rank/ }));
    expect(order()).toEqual(["Bob Baker", "Carol Clark", "Alice Anderson", "Dave Davis"]);
  });

  it("sorts by name, position, ADP and stage odds", async () => {
    const user = userEvent.setup();
    render(<PlayerBoard players={players()} canDraft={false} busy={false} onDraft={noop} />);

    await user.click(screen.getByRole("button", { name: /Player/ }));
    expect(order()).toEqual(["Alice Anderson", "Bob Baker", "Carol Clark", "Dave Davis"]);

    await user.click(screen.getByRole("button", { name: /Pos/ }));
    expect(order()).toEqual(["Dave Davis", "Carol Clark", "Bob Baker", "Alice Anderson"]);

    await user.click(screen.getByRole("button", { name: /ADP/ }));
    expect(order()).toEqual(["Bob Baker", "Alice Anderson", "Carol Clark", "Dave Davis"]);

    // Win% column = chance to reach CHAMPION, descending; no-data last.
    await user.click(screen.getByRole("button", { name: /Win%/ }));
    expect(order()).toEqual(["Bob Baker", "Carol Clark", "Alice Anderson", "Dave Davis"]);
  });
});

describe("PlayerBoard filtering", () => {
  it("filters by search text", async () => {
    const user = userEvent.setup();
    render(<PlayerBoard players={players()} canDraft={false} busy={false} onDraft={noop} />);
    await user.type(screen.getByPlaceholderText("Search by name"), "carol");
    expect(order()).toEqual(["Carol Clark"]);
  });

  it("filters by position", async () => {
    const user = userEvent.setup();
    render(<PlayerBoard players={players()} canDraft={false} busy={false} onDraft={noop} />);
    await user.selectOptions(screen.getByLabelText("Filter by position"), "DEF");
    expect(order()).toEqual(["Carol Clark"]);
  });

  it("filters by national team", async () => {
    const user = userEvent.setup();
    render(<PlayerBoard players={players()} canDraft={false} busy={false} onDraft={noop} />);
    await user.selectOptions(screen.getByLabelText("Filter by national team"), "Argentina");
    expect(new Set(order())).toEqual(new Set(["Bob Baker", "Dave Davis"]));
  });

  it("shows an empty-state when nothing matches", async () => {
    const user = userEvent.setup();
    render(<PlayerBoard players={players()} canDraft={false} busy={false} onDraft={noop} />);
    await user.type(screen.getByPlaceholderText("Search by name"), "zzzz");
    expect(screen.getByText("No players match those filters.")).toBeInTheDocument();
  });
});

describe("PlayerBoard draft-button gating", () => {
  it("disables every Draft button when it is not the viewer's pick", () => {
    render(<PlayerBoard players={players()} canDraft={false} busy={false} onDraft={noop} />);
    expect(draftBtn("Alice Anderson")).toBeDisabled();
    expect(screen.getByText(/not your pick/)).toBeInTheDocument();
  });

  it("enables Draft only for legal players on the viewer's pick", () => {
    render(<PlayerBoard players={players()} canDraft={true} busy={false} onDraft={noop} />);
    expect(draftBtn("Alice Anderson")).toBeEnabled(); // legal
    expect(draftBtn("Bob Baker")).toBeDisabled();      // illegal addition
    expect(screen.getByText(/it's your pick/)).toBeInTheDocument();
  });

  it("disables Draft while a pick is in flight (busy)", () => {
    render(<PlayerBoard players={players()} canDraft={true} busy={true} onDraft={noop} />);
    expect(draftBtn("Alice Anderson")).toBeDisabled();
  });

  it("fires onDraft with the player id when clicked", async () => {
    const user = userEvent.setup();
    const onDraft = vi.fn();
    render(<PlayerBoard players={players()} canDraft={true} busy={false} onDraft={onDraft} />);
    await user.click(draftBtn("Alice Anderson"));
    expect(onDraft).toHaveBeenCalledWith(1);
  });
});

describe("PlayerBoard queue toggle", () => {
  it("reflects queued state and toggles via onToggleQueue", async () => {
    const user = userEvent.setup();
    const onToggleQueue = vi.fn();
    render(
      <PlayerBoard
        players={players()}
        canDraft={false}
        busy={false}
        onDraft={noop}
        queuedIds={new Set([1])}
        onToggleQueue={onToggleQueue}
      />,
    );
    // Alice (id 1) is already queued; Carol is not.
    const aliceRow = screen.getByText("Alice Anderson").closest("tr") as HTMLTableRowElement;
    expect(within(aliceRow).getByRole("button", { name: "Queued" })).toBeInTheDocument();

    const carolRow = screen.getByText("Carol Clark").closest("tr") as HTMLTableRowElement;
    await user.click(within(carolRow).getByRole("button", { name: "+ Queue" }));
    expect(onToggleQueue).toHaveBeenCalledWith(3, true);
  });
});
