/**
 * SurvivorPanel - join the pool, make your stage pick, watch the board.
 * Other managers' picks stay hidden until a stage locks (the server masks
 * them); resolution marks each pick WIN/LOSS after the stage finishes.
 */
"use client";

import { useState } from "react";

export interface SurvivorTeamOption {
  id: number;
  name: string;
  status: string;
}

export interface SurvivorBoardPick {
  stage: string;
  nationalTeamId: number | null;
  teamName: string | null;
  resolvedOutcome: string | null;
  hidden: boolean;
}

export interface SurvivorBoardRow {
  managerId: number;
  managerName: string;
  livesRemaining: number;
  eliminatedAtStage: string | null;
  picks: SurvivorBoardPick[];
}

interface SurvivorPanelProps {
  leagueId: number;
  viewerManagerId: number;
  board: SurvivorBoardRow[];
  teams: SurvivorTeamOption[];
  /** stage -> ISO first kickoff (missing = no fixtures yet, open). */
  stageLocksAtUtc: Record<string, string>;
  stages: string[];
}

export default function SurvivorPanel({
  leagueId,
  viewerManagerId,
  board,
  teams,
  stageLocksAtUtc,
  stages,
}: SurvivorPanelProps) {
  const now = Date.now();
  const entered = board.some((r) => r.managerId === viewerManagerId);
  const mine = board.find((r) => r.managerId === viewerManagerId);
  const usedTeamIds = new Set(
    (mine?.picks ?? []).map((p) => p.nationalTeamId).filter((x) => x !== null),
  );
  const openStages = stages.filter((s) => {
    const lock = stageLocksAtUtc[s];
    return !lock || Date.parse(lock) > now;
  });

  const [stage, setStage] = useState<string>(openStages[0] ?? "");
  const [teamId, setTeamId] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function call(method: string, body?: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(body);
      }
      const res = await fetch(`/api/leagues/${leagueId}/survivor`, init);
      const parsed = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) throw new Error(parsed.error?.message ?? "request failed");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function join(): Promise<void> {
    if (await call("POST")) window.location.reload();
  }

  async function pick(): Promise<void> {
    if (!stage || teamId === "") return;
    if (await call("PUT", { stage, nationalTeamId: teamId })) {
      setMessage("Pick saved.");
      window.location.reload();
    }
  }

  return (
    <div className="survivor-panel">
      {!entered ? (
        <p>
          <button type="button" className="btn-sm" disabled={busy} onClick={() => void join()}>
            Join the survivor pool
          </button>
        </p>
      ) : mine?.eliminatedAtStage ? (
        <p className="notice">
          You were eliminated at {mine.eliminatedAtStage}. Better luck next
          tournament!
        </p>
      ) : (
        <p>
          <label>
            Stage{" "}
            <select value={stage} onChange={(e) => setStage(e.target.value)}>
              {openStages.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>{" "}
          <label>
            Nation{" "}
            <select
              value={teamId}
              onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">Pick a nation…</option>
              {teams
                .filter((t) => !usedTeamIds.has(t.id))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.status === "ELIMINATED" ? " (out)" : ""}
                  </option>
                ))}
            </select>
          </label>{" "}
          <button
            type="button"
            className="btn-sm"
            disabled={busy || !stage || teamId === "" || openStages.length === 0}
            onClick={() => void pick()}
          >
            Save pick
          </button>
          {message ? <span className="tag"> {message}</span> : null}
        </p>
      )}
      {error ? <p className="error">{error}</p> : null}

      {board.length > 0 ? (
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Survivor board"
        >
          <table>
            <thead>
              <tr>
                <th>Manager</th>
                <th className="num">Lives</th>
                <th>Status</th>
                <th>Picks</th>
              </tr>
            </thead>
            <tbody>
              {board.map((r) => (
                <tr key={r.managerId}>
                  <td>{r.managerName}</td>
                  <td className="num">{r.livesRemaining}</td>
                  <td>
                    {r.eliminatedAtStage
                      ? `Out (${r.eliminatedAtStage})`
                      : "Alive"}
                  </td>
                  <td>
                    {r.picks
                      .map((p) =>
                        p.hidden
                          ? `${p.stage}: \u{1F512}`
                          : `${p.stage}: ${p.teamName ?? "missed"}${
                              p.resolvedOutcome === "WIN"
                                ? " ✓"
                                : p.resolvedOutcome === "LOSS"
                                  ? " ✗"
                                  : ""
                            }`,
                      )
                      .join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="subtitle">Nobody has joined yet.</p>
      )}
    </div>
  );
}
