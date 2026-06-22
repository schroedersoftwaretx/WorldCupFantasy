// @vitest-environment jsdom
/**
 * QueuePanel — the draft pick-queue (presentational; parent owns mutations).
 *
 * Behaviour under test:
 *   - an empty queue shows guidance, not a list;
 *   - entries render in rank order with position, name and a "(drafted)" marker
 *     for players no longer available;
 *   - move-up is disabled at the top, move-down at the bottom, and moving an
 *     item emits the reordered id list;
 *   - remove emits the player id; `busy` disables every control.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "./setup";

import type { QueueEntry } from "../../src/data/draft/queue";
import QueuePanel from "../../app/leagues/[leagueId]/draft/queue-panel";

function queue(): QueueEntry[] {
  return [
    { playerId: 1, rank: 1, fullName: "First Pick", position: "FWD", available: true },
    { playerId: 2, rank: 2, fullName: "Second Pick", position: "MID", available: true },
    { playerId: 3, rank: 3, fullName: "Third Pick", position: "DEF", available: false },
  ];
}

const noop = () => {};

describe("QueuePanel", () => {
  it("shows an empty-state when there is nothing queued", () => {
    render(<QueuePanel queue={[]} busy={false} onReorder={noop} onRemove={noop} />);
    expect(screen.getByText(/Queue is empty/)).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("lists entries in order and marks drafted players", () => {
    render(<QueuePanel queue={queue()} busy={false} onReorder={noop} onRemove={noop} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("First Pick");
    expect(items[2]).toHaveTextContent("Third Pick");
    // The unavailable (drafted) player is flagged.
    expect(items[2]).toHaveTextContent("(drafted)");
    expect(items[0]).not.toHaveTextContent("(drafted)");
  });

  it("disables move-up at the top and move-down at the bottom", () => {
    render(<QueuePanel queue={queue()} busy={false} onReorder={noop} onRemove={noop} />);
    expect(screen.getByRole("button", { name: "Move First Pick up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move First Pick down" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Move Third Pick down" })).toBeDisabled();
  });

  it("emits the reordered id list when an item moves up", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    render(<QueuePanel queue={queue()} busy={false} onReorder={onReorder} onRemove={noop} />);
    await user.click(screen.getByRole("button", { name: "Move Second Pick up" }));
    // Player 2 swaps above player 1.
    expect(onReorder).toHaveBeenCalledWith([2, 1, 3]);
  });

  it("emits the player id on remove", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<QueuePanel queue={queue()} busy={false} onReorder={noop} onRemove={onRemove} />);
    await user.click(screen.getByRole("button", { name: "Remove Second Pick from queue" }));
    expect(onRemove).toHaveBeenCalledWith(2);
  });

  it("disables every control while busy", () => {
    render(<QueuePanel queue={queue()} busy={true} onReorder={noop} onRemove={noop} />);
    for (const btn of screen.getAllByRole("button")) {
      expect(btn).toBeDisabled();
    }
  });
});
