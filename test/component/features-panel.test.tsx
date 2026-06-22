// @vitest-environment jsdom
/**
 * FeaturesPanel — owner feature-flag switches with optimistic PUTs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "./setup";

import FeaturesPanel from "../../app/leagues/[leagueId]/settings/features-panel";

afterEach(() => vi.unstubAllGlobals());

describe("FeaturesPanel", () => {
  it("reflects the initial flag state", () => {
    render(<FeaturesPanel leagueId={1} initial={{ stats_hub: true, chat: false }} />);
    expect(screen.getByRole("checkbox", { name: /Stats Hub/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /League chat/ })).not.toBeChecked();
  });

  it("PUTs the toggle and reconciles with the server state", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ data: { flags: { chat: { enabled: true } } } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<FeaturesPanel leagueId={9} initial={{ chat: false }} />);
    await user.click(screen.getByRole("checkbox", { name: /League chat/ }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/leagues/9/flags",
      expect.objectContaining({ method: "PUT" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ flag: "chat", enabled: true });
    expect(screen.getByRole("checkbox", { name: /League chat/ })).toBeChecked();
  });

  it("rolls back the optimistic toggle and shows an error on failure", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: false, json: async () => ({ error: { message: "nope" } }) })),
    );

    render(<FeaturesPanel leagueId={9} initial={{ chat: false }} />);
    const box = screen.getByRole("checkbox", { name: /League chat/ });
    await user.click(box);

    expect(await screen.findByText("nope")).toBeInTheDocument();
    expect(box).not.toBeChecked(); // rolled back
  });
});
