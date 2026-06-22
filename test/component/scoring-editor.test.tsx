// @vitest-environment jsdom
/**
 * ScoringEditor — prefilled rule editor that PUTs structured values on save.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "./setup";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

import { DEFAULT_RULESET } from "../../src/data/scoring/ruleset";
import ScoringEditor from "../../app/leagues/[leagueId]/scoring/scoring-editor";

afterEach(() => {
  vi.unstubAllGlobals();
  refresh.mockReset();
});

describe("ScoringEditor", () => {
  it("prefills inputs from the league ruleset", () => {
    render(<ScoringEditor leagueId={1} ruleset={DEFAULT_RULESET} />);
    expect(screen.getByLabelText("Assist")).toHaveValue(DEFAULT_RULESET.assist);
    expect(screen.getByLabelText("Goal — FWD")).toHaveValue(DEFAULT_RULESET.goalByPosition.FWD);
  });

  it("PUTs edited values and reports the new ruleset version", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        ok: true,
        data: { version: "wcf-v9", inserted: 2, updated: 3, skipped: 1 },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ScoringEditor leagueId={7} ruleset={DEFAULT_RULESET} />);
    const assist = screen.getByLabelText("Assist");
    await user.clear(assist);
    await user.type(assist, "5");
    await user.click(screen.getByRole("button", { name: "Save & recompute" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/leagues/7/scoring",
      expect.objectContaining({ method: "PUT" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.assist).toBe(5);
    expect(await screen.findByText(/ruleset wcf-v9/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("Reset restores the original values after an edit", async () => {
    const user = userEvent.setup();
    render(<ScoringEditor leagueId={1} ruleset={DEFAULT_RULESET} />);
    const assist = screen.getByLabelText("Assist");
    await user.clear(assist);
    await user.type(assist, "99");
    expect(assist).toHaveValue(99);
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByLabelText("Assist")).toHaveValue(DEFAULT_RULESET.assist);
  });
});
