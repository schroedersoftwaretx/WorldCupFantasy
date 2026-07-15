/**
 * LineupEditor - client-side XI picker for SET_LINEUP leagues.
 *
 * Pick a scoring period, toggle 11 players from the 23-man roster into the
 * XI (any formation of the league's formation set, or a chosen preset),
 * choose captain and optional vice, submit via PUT /api/leagues/:id/lineup.
 * Locked periods
 * (first kickoff passed) are read-only. A period with no submission shows
 * the rolled-forward lineup the scorer would use, when one exists.
 */
"use client";

import { useMemo, useState } from "react";

export interface LineupRosterPlayer {
  playerId: number;
  fullName: string;
  position: "GK" | "DEF" | "MID" | "FWD";
}

/** One legal XI shape, e.g. { label: "4-4-2", GK: 1, DEF: 4, MID: 4, FWD: 2 }. */
export interface LineupFormation {
  label: string;
  GK: number;
  DEF: number;
  MID: number;
  FWD: number;
}

export interface LineupPeriod {
  scoringPeriodId: number;
  ordinal: number;
  label: string;
  /** ISO string, or null when the period has no fixtures yet. */
  locksAtUtc: string | null;
}

export interface ExistingLineup {
  scoringPeriodId: number;
  playerIds: number[];
  captainPlayerId: number;
  viceCaptainPlayerId: number | null;
}

interface LineupEditorProps {
  leagueId: number;
  teamId: number;
  roster: LineupRosterPlayer[];
  periods: LineupPeriod[];
  lineups: ExistingLineup[];
  /** The league's legal formations (its formation set). */
  formations: LineupFormation[];
}

const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;
type Pos = (typeof POSITIONS)[number];

/** Per-position [min, max] across a formation list (for the Any option). */
function rangesFrom(
  formations: readonly LineupFormation[],
): Record<Pos, [number, number]> {
  const out = {} as Record<Pos, [number, number]>;
  for (const pos of POSITIONS) {
    const ns = formations.map((f) => f[pos]);
    out[pos] = [Math.min(...ns), Math.max(...ns)];
  }
  return out;
}

/** The submitted (or rolled-forward) lineup covering a period, if any. */
function effectiveFor(
  lineups: ExistingLineup[],
  periods: LineupPeriod[],
  targetOrdinal: number,
): ExistingLineup | null {
  const ordinalById = new Map(periods.map((p) => [p.scoringPeriodId, p.ordinal]));
  let best: ExistingLineup | null = null;
  let bestOrd = -Infinity;
  for (const l of lineups) {
    const ord = ordinalById.get(l.scoringPeriodId);
    if (ord === undefined || ord > targetOrdinal) continue;
    if (ord > bestOrd) {
      best = l;
      bestOrd = ord;
    }
  }
  return best;
}

export default function LineupEditor({
  leagueId,
  teamId,
  roster,
  periods,
  lineups,
  formations,
}: LineupEditorProps) {
  const now = Date.now();
  const firstOpen =
    periods.find((p) => p.locksAtUtc === null || Date.parse(p.locksAtUtc) > now) ??
    periods[0];

  const [saved, setSaved] = useState<ExistingLineup[]>(lineups);
  const [periodId, setPeriodId] = useState<number>(firstOpen?.scoringPeriodId ?? 0);
  const period = periods.find((p) => p.scoringPeriodId === periodId);
  const locked =
    !!period?.locksAtUtc && Date.parse(period.locksAtUtc) <= now;

  const effective = useMemo(
    () => (period ? effectiveFor(saved, periods, period.ordinal) : null),
    [saved, periods, period],
  );
  const isRolledForward =
    effective !== null && effective.scoringPeriodId !== periodId;

  const [xi, setXi] = useState<Set<number>>(
    () => new Set(effective?.playerIds ?? []),
  );
  const [captain, setCaptain] = useState<number | null>(
    effective?.captainPlayerId ?? null,
  );
  const [vice, setVice] = useState<number | null>(
    effective?.viceCaptainPlayerId ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** "" = any legal formation; otherwise a preset's label, e.g. "4-4-2". */
  const [preset, setPreset] = useState<string>("");
  const chosen = formations.find((f) => f.label === preset) ?? null;
  const range = useMemo(() => rangesFrom(formations), [formations]);

  function selectPeriod(nextId: number): void {
    setPeriodId(nextId);
    const p = periods.find((x) => x.scoringPeriodId === nextId);
    const eff = p ? effectiveFor(saved, periods, p.ordinal) : null;
    setXi(new Set(eff?.playerIds ?? []));
    setCaptain(eff?.captainPlayerId ?? null);
    setVice(eff?.viceCaptainPlayerId ?? null);
    setMessage(null);
    setError(null);
  }

  function toggle(pid: number): void {
    const next = new Set(xi);
    if (next.has(pid)) {
      next.delete(pid);
      if (captain === pid) setCaptain(null);
      if (vice === pid) setVice(null);
    } else {
      next.add(pid);
    }
    setXi(next);
    setMessage(null);
  }

  const counts = useMemo(() => {
    const c = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    for (const p of roster) if (xi.has(p.playerId)) c[p.position] += 1;
    return c;
  }, [xi, roster]);

  // Legal = the XI's counts exactly match some formation of the set (or the
  // chosen preset). The server enforces the same rule.
  const formationOk =
    xi.size === 11 &&
    (chosen
      ? POSITIONS.every((pos) => counts[pos] === chosen[pos])
      : formations.some((f) => POSITIONS.every((pos) => counts[pos] === f[pos])));
  const ready = formationOk && captain !== null && xi.has(captain);

  async function handleSave(): Promise<void> {
    if (!ready || captain === null) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/leagues/${leagueId}/lineup`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId,
          scoringPeriodId: periodId,
          playerIds: [...xi],
          captainPlayerId: captain,
          viceCaptainPlayerId: vice,
        }),
      });
      const body = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) {
        throw new Error(body.error?.message ?? "could not save lineup");
      }
      setSaved((prev) => [
        ...prev.filter((l) => l.scoringPeriodId !== periodId),
        {
          scoringPeriodId: periodId,
          playerIds: [...xi],
          captainPlayerId: captain,
          viceCaptainPlayerId: vice,
        },
      ]);
      setMessage("Lineup saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not save lineup");
    } finally {
      setBusy(false);
    }
  }

  if (periods.length === 0 || !period) {
    return <p className="notice">No scoring periods available yet.</p>;
  }

  return (
    <div className="lineup-editor">
      <label>
        Period{" "}
        <select
          value={periodId}
          onChange={(e) => selectPeriod(Number(e.target.value))}
        >
          {periods.map((p) => {
            const isLocked = !!p.locksAtUtc && Date.parse(p.locksAtUtc) <= now;
            return (
              <option key={p.scoringPeriodId} value={p.scoringPeriodId}>
                {p.label}
                {isLocked ? " (locked)" : ""}
              </option>
            );
          })}
        </select>
      </label>
      {period.locksAtUtc ? (
        <p className="subtitle">
          {locked ? "Locked since " : "Locks at "}
          {new Date(period.locksAtUtc).toLocaleString()}
        </p>
      ) : (
        <p className="subtitle">No fixtures scheduled yet - lineup stays open.</p>
      )}
      {isRolledForward ? (
        <p className="notice">
          No lineup submitted for {period.label}; showing the lineup that
          rolls forward. Save to pin one for this period.
        </p>
      ) : null}

      <label>
        Formation{" "}
        <select
          disabled={locked}
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
        >
          <option value="">Any legal formation</option>
          {formations.map((f) => (
            <option key={f.label} value={f.label}>
              {f.label}
            </option>
          ))}
        </select>
      </label>

      <p aria-live="polite">
        Selected {xi.size}/11 &middot; GK {counts.GK} &middot; DEF {counts.DEF}{" "}
        &middot; MID {counts.MID} &middot; FWD {counts.FWD}
        {!formationOk && xi.size === 11
          ? ` - not a legal formation (${
              chosen ? chosen.label : formations.map((f) => f.label).join(", ")
            })`
          : ""}
      </p>

      {POSITIONS.map((pos) => (
        <fieldset key={pos} disabled={locked}>
          <legend>
            {pos} (
            {chosen
              ? chosen[pos]
              : range[pos][0] === range[pos][1]
                ? range[pos][0]
                : `${range[pos][0]}-${range[pos][1]}`}
            )
          </legend>
          {roster
            .filter((p) => p.position === pos)
            .map((p) => (
              <label key={p.playerId} className="lineup-player">
                <input
                  type="checkbox"
                  checked={xi.has(p.playerId)}
                  onChange={() => toggle(p.playerId)}
                />{" "}
                {p.fullName}
                {captain === p.playerId ? " (C)" : ""}
                {vice === p.playerId ? " (V)" : ""}
              </label>
            ))}
        </fieldset>
      ))}

      <label>
        Captain{" "}
        <select
          disabled={locked}
          value={captain ?? ""}
          onChange={(e) => {
            const v = e.target.value ? Number(e.target.value) : null;
            setCaptain(v);
            if (v !== null && vice === v) setVice(null);
          }}
        >
          <option value="">Pick a captain…</option>
          {roster
            .filter((p) => xi.has(p.playerId))
            .map((p) => (
              <option key={p.playerId} value={p.playerId}>
                {p.fullName}
              </option>
            ))}
        </select>
      </label>{" "}
      <label>
        Vice{" "}
        <select
          disabled={locked}
          value={vice ?? ""}
          onChange={(e) => setVice(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">No vice-captain</option>
          {roster
            .filter((p) => xi.has(p.playerId) && p.playerId !== captain)
            .map((p) => (
              <option key={p.playerId} value={p.playerId}>
                {p.fullName}
              </option>
            ))}
        </select>
      </label>

      <p>
        <button
          type="button"
          className="btn-sm"
          disabled={busy || locked || !ready}
          onClick={() => void handleSave()}
        >
          {busy ? "Saving…" : "Save lineup"}
        </button>
        {locked ? <span className="notice"> This period is locked.</span> : null}
        {message ? <span className="tag"> {message}</span> : null}
        {error ? <span className="error"> {error}</span> : null}
      </p>
    </div>
  );
}
