// @vitest-environment jsdom
/**
 * RenameTeamForm — inline edit of the viewer's team name.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "./setup";

import RenameTeamForm from "../../app/leagues/[leagueId]/rename-team-form";

let origLocation: Location;
beforeEach(() => {
  origLocation = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { href: "http://localhost/", assign: vi.fn(), reload: vi.fn() },
  });
});
afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: origLocation });
  vi.unstubAllGlobals();
});

describe("RenameTeamForm", () => {
  it("shows the current name with a Rename button by default", () => {
    render(<RenameTeamForm leagueId={1} currentName="Old Name" />);
    expect(screen.getByText("Old Name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("reveals an input when Rename is clicked", async () => {
    const user = userEvent.setup();
    render(<RenameTeamForm leagueId={1} currentName="Old Name" />);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByRole("textbox")).toHaveValue("Old Name");
  });

  it("PATCHes the new name and reloads on save", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ data: { teamName: "New Name" } }) }));
    vi.stubGlobal("fetch", fetchMock);

    render(<RenameTeamForm leagueId={5} currentName="Old Name" />);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "New Name");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/leagues/5/team",
      expect.objectContaining({ method: "PATCH" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ name: "New Name" });
    expect(window.location.reload).toHaveBeenCalled();
  });

  it("Cancel returns to the read-only view without fetching", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<RenameTeamForm leagueId={1} currentName="Old Name" />);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
