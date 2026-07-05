/**
 * ChipsPanel - client-side chips & captain controls.
 *
 * Best-ball leagues: nominate a period captain (x2) and spend one-shot
 * chips. SET_LINEUP leagues: the captain comes from the lineup page, so
 * only the chips controls show. Selections lock at each period's first
 * kickoff; every rule (one use, no stacking, locks) is enforced by the
 * API - this panel just surfaces the errors.
 */
"use client";

import { useState } from "react";

export interface ChipsPeriod {
  scoringPeriodId: number;
  ordinal: number;
  label: string;
  locksAtUtc: string | null;
}

export interface ChipsRosterPlayer {
  playerId: number;
  fullName: string;
  position: "GK" | "DEF" | "MID" | "FWD";
}

export interface PlayedChip {
  chip: string;
  scoringPeriodId: number;
}

export interface CaptainPick {
  scoringPeriodId: number;
  playerId: number;
}

interface ChipsPanelProps {
  leagueId: number;
  teamId: number;
  format: string;
  periods: ChipsPeriod[];
  roster: ChipsRosterPlayer[];
  played: PlayedChip[];
  remaining: string[];
  captains: CaptainPick[];
}

const CHIP_LABEL: Record<string, string> = {
  TRIPLE_CAPTAIN: "Triple Captain (captain scores x3)",
  BENCH_BOOST: "Bench Boost (all 23 players score)",
  STAGE_BOOST: "Stage Boost (period total doubled)",
};

export default function ChipsPanel({
  leagueId,
  teamId,
  format,
  periods,
  roster,
  played,
  remaining,
  captains,
}: ChipsPanelProps) {
  const now = Date.now();
  const openPeriods = periods.filter(
    (p) => p.locksAtUtc === null || Date.parse(p.locksAtUtc) > now,
  );
  const labelById = new Map(periods.map((p) => [p.scoringPeriodId, p.label]));

  const [capPeriod, setCapPeriod] = useState<number>(
    openPeriods[0]?.scoringPeriodId ?? 0,
  );
  const [capPlayer, setCapPlayer] = useState<number | "">("");
  const [chip, setChip] = useState<string>(remaining[0] ?? "");
  const [chipPeriod, setChipPeriod] = useState<number>(
    openPeriods[0]?.scoringPeriodId ?? 0,
  );
  const [capsState, setCapsState] = useState<CaptainPick[]>(captains);
  const [playedState, setPlayedState] = useState<PlayedChip[]>(played);
  const [remainingState, setRemainingState] = useState<string[]>(remaining);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function post(url: string, method: string, body: unknown): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) throw new Error(parsed.error?.message ?? "request failed");
      setMessage("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function saveCaptain(): Promise<void> {
    if (capPlayer === "") return;
    try {
      await post(`/api/leagues/${leagueId}/chips/captain`, "PUT", {
        teamId,
        scoringPeriodId: capPeriod,
        playerId: capPlayer,
      });
      setCapsState((prev) => [
        ...prev.filter((c) => c.scoringPeriodId !== capPeriod),
        { scoringPeriodId: capPeriod, playerId: capPlayer },
      ]);
    } catch {
      /* error already surfaced */
    }
  }

  async function spendChip(): Promise<void> {
    if (!chip) return;
    try {
      await post(`/api/leagues/${leagueId}/chips`, "POST", {
        teamId,
        scoringPeriodId: chipPeriod,
        chip,
      });
      setPlayedState((prev) => [...prev, { chip, scoringPeriodId: chipPeriod }]);
      setRemainingState((prev) => {
        const next = prev.filter((c) => c !== chip);
        setChip(next[0] ?? "");
        return next;
      });
    } catch {
      /* error already surfaced */
    }
  }

  const nameById = new Map(roster.map((p) => [p.playerId, p.fullName]));

  return (
    <div className="chips-panel">
      {format !== "SET_LINEUP" ? (
        <section>
          <h2>Period captain</h2>
          <p className="subtitle">
            Your captain&apos;s points count double that period (triple with
            the Triple Captain chip).
          </p>
          {capsState.length > 0 ? (
            <ul>
              {capsState
                .slice()
                .sort((a, b) => a.scoringPeriodId - b.scoringPeriodId)
                .map((c) => (
                  <li key={c.scoringPeriodId}>
                    {labelById.get(c.scoringPeriodId) ?? c.scoringPeriodId}:{" "}
                    {nameById.get(c.playerId) ?? `#${c.playerId}`}
                  </li>
                ))}
            </ul>
          ) : null}
          <label>
            Period{" "}
            <select
              value={capPeriod}
              onChange={(e) => setCapPeriod(Number(e.target.value))}
            >
              {openPeriods.map((p) => (
                <option key={p.scoringPeriodId} value={p.scoringPeriodId}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>{" "}
          <label>
            Player{" "}
            <select
              value={capPlayer}
              onChange={(e) =>
                setCapPlayer(e.target.value ? Number(e.target.value) : "")
              }
            >
              <option value="">Pick a player…</option>
              {roster.map((p) => (
                <option key={p.playerId} value={p.playerId}>
                  {p.fullName} ({p.position})
                </option>
              ))}
            </select>
          </label>{" "}
          <button
            type="button"
            className="btn-sm"
            disabled={busy || capPlayer === "" || openPeriods.length === 0}
            onClick={() => void saveCaptain()}
          >
            Set captain
          </button>
        </section>
      ) : (
        <p className="subtitle">
          Captains for this league are set on the Lineup page.
        </p>
      )}

      <section>
        <h2>Chips</h2>
        {playedState.length > 0 ? (
          <ul>
            {playedState.map((c) => (
              <li key={c.chip}>
                {CHIP_LABEL[c.chip] ?? c.chip} &mdash; played on{" "}
                {labelById.get(c.scoringPeriodId) ?? c.scoringPeriodId}
              </li>
            ))}
          </ul>
        ) : (
          <p className="subtitle">No chips played yet.</p>
        )}
        {remainingState.length === 0 ? (
          <p className="notice">All chips used.</p>
        ) : (
          <p>
            <label>
              Chip{" "}
              <select value={chip} onChange={(e) => setChip(e.target.value)}>
                {remainingState.map((c) => (
                  <option key={c} value={c}>
                    {CHIP_LABEL[c] ?? c}
                  </option>
                ))}
              </select>
            </label>{" "}
            <label>
              Period{" "}
              <select
                value={chipPeriod}
                onChange={(e) => setChipPeriod(Number(e.target.value))}
              >
                {openPeriods.map((p) => (
                  <option key={p.scoringPeriodId} value={p.scoringPeriodId}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>{" "}
            <button
              type="button"
              className="btn-sm"
              disabled={busy || !chip || openPeriods.length === 0}
              onClick={() => void spendChip()}
            >
              Play chip
            </button>
          </p>
        )}
        <p className="subtitle">
          Each chip works once, chips can&apos;t share a period, and picks lock
          at the period&apos;s first kickoff.
        </p>
      </section>
      {message ? <span className="tag">{message}</span> : null}
      {error ? <span className="error">{error}</span> : null}
    </div>
  );
}
