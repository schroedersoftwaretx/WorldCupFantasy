// @vitest-environment jsdom
/**
 * CreateLeagueForm — dashboard form that POSTs /api/leagues then navigates.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "./setup";

import CreateLeagueForm from "../../app/create-league-form";

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

describe("CreateLeagueForm", () => {
  it("POSTs the entered name + size and navigates to the new league", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ data: { leagueId: 42 } }) }));
    vi.stubGlobal("fetch", fetchMock);

    render(<CreateLeagueForm />);
    await user.type(screen.getByLabelText("League name"), "Office Cup");
    await user.clear(screen.getByLabelText("Managers"));
    await user.type(screen.getByLabelText("Managers"), "8");
    await user.click(screen.getByRole("button", { name: "Create league" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/leagues",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({
      name: "Office Cup",
      maxManagers: 8,
      format: "BEST_BALL",
      formationSet: "CLASSIC",
    });
    expect(window.location.assign).toHaveBeenCalledWith("/leagues/42");
  });

  it("surfaces the server error message and re-enables the button", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: false, json: async () => ({ error: { message: "name taken" } }) })),
    );

    render(<CreateLeagueForm />);
    await user.type(screen.getByLabelText("League name"), "Dupe");
    await user.click(screen.getByRole("button", { name: "Create league" }));

    expect(await screen.findByText("name taken")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create league" })).toBeEnabled();
  });
});
