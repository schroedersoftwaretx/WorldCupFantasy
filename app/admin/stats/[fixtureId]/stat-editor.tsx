"use client";
/**
 * Client-side stat editor table. One row per player; each numeric stat is an
 * editable input. Saving a row POSTs the full line to /api/admin/stats, which
 * locks the row and recomputes scores. Local state holds edits until saved.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

export interface EditorStat {
  minutesPlayed: number;
  goals: number;
  assists: number;
  saves: number;
  yellowCards: number;
  redCards: number;
  penaltiesScored: number;
  penaltiesMissed: number;
  penaltiesSaved: number;
  ownGoals: number;
  teamConcededInRegulationAndEt: number;
  teamScoredInRegulationAndEt: number;
  shotsOnTarget: number;
  shotsOffTarget: number;
  tacklesSuccessful: number;
  crosses: number;
  passesCompleted: number;
  keyPasses: number;
  bigChancesCreated: number;
  goalsConceded: number;
}

export interface EditorRow {
  playerId: number;
  fullName: string;
  position: string;
  teamName: string;
  manuallyEdited: boolean;
  stat: EditorStat;
}

interface Props {
  fixtureId: number;
  rows: EditorRow[];
}

/** Column definitions: stat key + short header + long tooltip. */
const COLS: Array<{ key: keyof EditorStat; label: string; title: string }> = [
  { key: "minutesPlayed", label: "Min", title: "Minutes played" },
  { key: "goals", label: "G", title: "Goals" },
  { key: "assists", label: "A", title: "Assists" },
  { key: "saves", label: "Sv", title: "Saves (GK)" },
  { key: "goalsConceded", label: "GC", title: "Goals conceded (GK)" },
  { key: "shotsOnTarget", label: "SoT", title: "Shots on target" },
  { key: "shotsOffTarget", label: "Soff", title: "Shots off target" },
  { key: "tacklesSuccessful", label: "Tkl", title: "Successful tackles" },
  { key: "crosses", label: "Crs", title: "Crosses" },
  { key: "passesCompleted", label: "Pass", title: "Completed passes" },
  { key: "keyPasses", label: "KP", title: "Key passes (pass leading to a shot)" },
  { key: "bigChancesCreated", label: "BCC", title: "Big chances created" },
  { key: "yellowCards", label: "YC", title: "Yellow cards" },
  { key: "redCards", label: "RC", title: "Red cards" },
  { key: "penaltiesScored", label: "PSc", title: "Penalties scored" },
  { key: "penaltiesMissed", label: "PMs", title: "Penalties missed" },
  { key: "penaltiesSaved", label: "PSv", title: "Penalties saved (GK)" },
  { key: "ownGoals", label: "OG", title: "Own goals" },
  { key: "teamScoredInRegulationAndEt", label: "TmF", title: "Team goals for (reg+ET)" },
  { key: "teamConcededInRegulationAndEt", label: "TmA", title: "Team goals against (reg+ET)" },
];

interface RowStatus {
  busy: boolean;
  msg: string | null;
  error: boolean;
}

export default function StatEditor({ fixtureId, rows }: Props) {
  const router = useRouter();
  const [data, setData] = useState<EditorRow[]>(rows);
  const [status, setStatus] = useState<Record<number, RowStatus>>({});

  function setField(playerId: number, key: keyof EditorStat, value: number) {
    setData((prev) =>
      prev.map((r) =>
        r.playerId === playerId ? { ...r, stat: { ...r.stat, [key]: value } } : r,
      ),
    );
  }

  async function save(row: EditorRow) {
    setStatus((s) => ({ ...s, [row.playerId]: { busy: true, msg: null, error: false } }));
    try {
      const res = await fetch("/api/admin/stats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fixtureId,
          playerId: row.playerId,
          edit: row.stat,
          note: "edited via admin stat editor",
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setData((prev) =>
          prev.map((r) => (r.playerId === row.playerId ? { ...r, manuallyEdited: true } : r)),
        );
        setStatus((s) => ({
          ...s,
          [row.playerId]: { busy: false, msg: "Saved", error: false },
        }));
        router.refresh();
      } else {
        setStatus((s) => ({
          ...s,
          [row.playerId]: {
            busy: false,
            msg: json.error?.message ?? "Save failed",
            error: true,
          },
        }));
      }
    } catch (e) {
      setStatus((s) => ({
        ...s,
        [row.playerId]: {
          busy: false,
          msg: e instanceof Error ? e.message : "Network error",
          error: true,
        },
      }));
    }
  }

  return (
    <div className="table-scroll">
      <table className="stat-editor-table">
        <thead>
          <tr>
            <th>Player</th>
            <th>Pos</th>
            {COLS.map((c) => (
              <th key={c.key} className="num" title={c.title}>
                {c.label}
              </th>
            ))}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => {
            const st = status[row.playerId];
            return (
              <tr key={row.playerId}>
                <td>
                  {row.fullName}
                  {row.manuallyEdited && (
                    <span className="tag" title="Manually edited; locked from re-ingest">
                      edited
                    </span>
                  )}
                </td>
                <td>{row.position}</td>
                {COLS.map((c) => (
                  <td key={c.key} className="num">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      className="stat-input"
                      value={row.stat[c.key]}
                      onChange={(e) =>
                        setField(
                          row.playerId,
                          c.key,
                          Math.max(0, Math.floor(Number(e.target.value) || 0)),
                        )
                      }
                    />
                  </td>
                ))}
                <td>
                  <button
                    className="btn btn-sm"
                    onClick={() => save(row)}
                    disabled={st?.busy}
                  >
                    {st?.busy ? "Saving…" : "Save"}
                  </button>
                  {st?.msg && (
                    <span className={st.error ? "recompute-error" : "recompute-ok"}>
                      {st.msg}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
