/**
 * The draft room (client component).
 *
 * Subscribes to the draft state over Server-Sent Events (falling back to
 * polling if the stream drops), and renders the right view for the draft's
 * status: a create form, a start screen, the live room (player board + roster
 * + order + picks), or a completed summary. All mutations go through the POST
 * routes; the live stream reflects the result.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { DraftBoardPlayer, DraftStateData } from "@/web/api-types";

import PlayerBoard from "./player-board";
import { BestLineupViz } from "./best-lineup";
import { ScoringRules } from "./scoring-rules";

const POLL_MS = 5000;
const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;
const POSITION_MAX: Record<(typeof POSITIONS)[number], number> = {
  GK: 4,
  DEF: 8,
  MID: 8,
  FWD: 8,
};

/** Render a millisecond duration as a short countdown string. */
function formatRemaining(ms: number): string {
  if (ms <= 0) return "overdue";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

interface Envelope {
  data?: unknown;
  error?: { message?: string };
}

async function readBody(res: Response): Promise<Envelope | null> {
  return res.json().catch(() => null);
}

export default function DraftRoom({ leagueId }: { leagueId: number }) {
  const [state, setState] = useState<DraftStateData | null>(null);
  const [board, setBoard] = useState<DraftBoardPlayer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [timerInput, setTimerInput] = useState("12");
  const boardBasis = useRef<number>(-1);
  const wasOnClock = useRef(false);
  const baseTitle = useRef<string>("");

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch(`/api/leagues/${leagueId}/draft`, {
        cache: "no-store",
      });
      const body = await readBody(res);
      if (!res.ok || !body?.data) {
        throw new Error(body?.error?.message ?? "could not load the draft");
      }
      setState(body.data as DraftStateData);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "could not load the draft");
    }
  }, [leagueId]);

  const fetchBoard = useCallback(async () => {
    try {
      const res = await fetch(`/api/leagues/${leagueId}/draft/board`, {
        cache: "no-store",
      });
      const body = await readBody(res);
      if (!res.ok || !body?.data) {
        throw new Error(body?.error?.message ?? "could not load the board");
      }
      setBoard((body.data as { players: DraftBoardPlayer[] }).players);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "could not load the board");
    }
  }, [leagueId]);

  // Live state via Server-Sent Events: the stream pushes a fresh payload on
  // connect and whenever a pick or timeout changes the draft, so updates land
  // in ~1-2s instead of a 5s poll. If the stream errors and the browser gives
  // up reconnecting, we fall back to polling so the draft never silently stalls.
  useEffect(() => {
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (pollTimer) return;
      void fetchState();
      pollTimer = setInterval(() => void fetchState(), POLL_MS);
    };

    if (typeof EventSource !== "undefined") {
      es = new EventSource(`/api/leagues/${leagueId}/draft/stream`);
      es.onmessage = (e) => {
        try {
          setState(JSON.parse(e.data) as DraftStateData);
          setLoadError(null);
        } catch {
          /* ignore a malformed frame; the next one will be clean */
        }
      };
      es.onerror = () => {
        // The browser auto-retries transient drops (readyState CONNECTING).
        // Only when it gives up (CLOSED) do we fall back to polling.
        if (es && es.readyState === EventSource.CLOSED) {
          es = null;
          startPolling();
        }
      };
    } else {
      startPolling();
    }

    return () => {
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [leagueId, fetchState]);

  // Refetch the (heavier) board only when the pick count changes.
  useEffect(() => {
    if (!state || state.draftRoomId === null) return;
    if (boardBasis.current !== state.picksMade) {
      boardBasis.current = state.picksMade;
      void fetchBoard();
    }
  }, [state, fetchBoard]);

  // One-second clock for the deadline countdown.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Ask for notification permission once, so we can alert the manager when
  // their pick comes up while they're in another tab.
  useEffect(() => {
    baseTitle.current = document.title;
    if (
      typeof window !== "undefined" &&
      "Notification" in window &&
      Notification.permission === "default"
    ) {
      void Notification.requestPermission().catch(() => {});
    }
    return () => {
      document.title = baseTitle.current || "Draft Room";
    };
  }, []);

  // Make it impossible to miss your turn: flip the tab title and fire a
  // browser notification the moment the viewer goes on the clock.
  useEffect(() => {
    const onClock =
      state?.status === "IN_PROGRESS" && state.viewer.isOnClock === true;

    document.title = onClock
      ? "⏰ Your pick! — Draft Room"
      : baseTitle.current || "Draft Room";

    if (onClock && !wasOnClock.current) {
      if (
        typeof window !== "undefined" &&
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        try {
          new Notification("You're on the clock!", {
            body: "It's your pick in the draft.",
          });
        } catch {
          /* some browsers throw if constructed outside a SW; ignore */
        }
      }
    }
    wasOnClock.current = onClock;
  }, [state]);

  const runAction = useCallback(
    async (path: string, payload?: unknown): Promise<void> => {
      setActionBusy(true);
      setActionError(null);
      try {
        const res = await fetch(`/api/leagues/${leagueId}${path}`, {
          method: "POST",
          ...(payload !== undefined
            ? {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              }
            : {}),
        });
        const body = await readBody(res);
        if (!res.ok) {
          throw new Error(body?.error?.message ?? "the action failed");
        }
        boardBasis.current = -1;
        await fetchState();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "the action failed");
      } finally {
        setActionBusy(false);
      }
    },
    [leagueId, fetchState],
  );

  if (!state) {
    return (
      <p className={loadError ? "error" : "notice"}>
        {loadError ?? "Loading the draft..."}
      </p>
    );
  }

  const { viewer } = state;
  const errorBar = actionError ? (
    <p className="error">{actionError}</p>
  ) : null;

  // Owner-only heads-up when email delivery isn't configured, so they know
  // managers won't get "you're on the clock" emails.
  const emailWarning =
    viewer.isOwner && !state.emailNotifications ? (
      <p className="notice">
        Email notifications are off (Resend not configured) — managers
        won&apos;t get &ldquo;you&apos;re on the clock&rdquo; emails. Set
        <code> RESEND_API_KEY</code> to enable them.
      </p>
    ) : null;

  // --- no draft room yet ----------------------------------------------------
  if (state.status === "NONE") {
    return (
      <>
        <h1>Draft room</h1>
        {errorBar}
        {viewer.isOwner ? (
          <div className="form-card">
            <h2>Set up the draft</h2>
            <p>Create the draft room, then start it once everyone has joined.</p>
            <div className="field">
              <label htmlFor="timer">Pick timer</label>
              <div className="timer-presets">
                {[
                  { label: "15 min", hours: 0.25 },
                  { label: "30 min", hours: 0.5 },
                  { label: "1 hr",   hours: 1 },
                  { label: "2 hr",   hours: 2 },
                  { label: "6 hr",   hours: 6 },
                  { label: "12 hr",  hours: 12 },
                  { label: "24 hr",  hours: 24 },
                  { label: "48 hr",  hours: 48 },
                ].map(({ label, hours }) => (
                  <button
                    key={hours}
                    type="button"
                    className={
                      Number(timerInput) === hours
                        ? "timer-preset timer-preset-active"
                        : "timer-preset"
                    }
                    onClick={() => setTimerInput(String(hours))}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <input
                id="timer"
                type="number"
                min={0}
                max={168}
                step={0.25}
                value={timerInput}
                onChange={(e) => setTimerInput(e.target.value)}
              />
              <span className="field-hint">
                Hours per pick — 12 hr is typical for async drafts, 15–30 min
                for a draft done in one sitting. Set 0 to disable the timer.
              </span>
            </div>
            <button
              type="button"
              className="btn"
              disabled={actionBusy}
              onClick={() =>
                void runAction("/draft", {
                  pickTimerHours: Number(timerInput),
                })
              }
            >
              {actionBusy ? "Creating..." : "Create draft"}
            </button>
          </div>
        ) : (
          <p className="notice">
            The league owner has not set up the draft yet.
          </p>
        )}
      </>
    );
  }

  // --- created, not started -------------------------------------------------
  if (state.status === "PENDING") {
    const enough = state.teamCount >= 2;
    return (
      <>
        <h1>Draft room</h1>
        {errorBar}
        {emailWarning}
        <p className="subtitle">
          The draft room is ready &mdash; {state.teamCount}{" "}
          {state.teamCount === 1 ? "manager has" : "managers have"} joined.
          Pick timer: {state.pickTimerHours}h.
        </p>
        {viewer.isOwner ? (
          <div className="panel">
            <h2>Start the draft</h2>
            {enough ? (
              <p>
                Starting freezes a random snake order and puts pick 1 on the
                clock.
              </p>
            ) : (
              <p className="error">
                A draft needs at least 2 managers. Invite another from the
                league page first.
              </p>
            )}
            <button
              type="button"
              className="btn"
              disabled={actionBusy || !enough}
              onClick={() => void runAction("/draft/start")}
            >
              {actionBusy ? "Starting..." : "Start draft"}
            </button>
          </div>
        ) : (
          <p className="notice">
            Waiting for the league owner to start the draft.
          </p>
        )}
      </>
    );
  }

  // --- in progress / complete: shared panels --------------------------------
  const inProgress = state.status === "IN_PROGRESS";
  const onClockSlot = state.order.find(
    (o) => o.fantasyTeamId === state.onClockTeamId,
  );
  const deadlineMs = state.currentPickDeadline
    ? new Date(state.currentPickDeadline).getTime()
    : null;
  const remaining = deadlineMs !== null ? deadlineMs - now : null;

  const rosterPanel = (
    <section className="panel">
      <h2>Your team</h2>
      <div className="counts-row">
        {POSITIONS.map((pos) => (
          <span key={pos} className="count-chip">
            {pos} {viewer.counts[pos]}/{POSITION_MAX[pos]}
          </span>
        ))}
        <span className="count-chip total">
          {viewer.roster.length}/{state.rosterSize}
        </span>
      </div>
      {viewer.roster.length === 0 ? (
        <p className="field-hint">No players drafted yet.</p>
      ) : (
        <ul className="roster-list">
          {viewer.roster.map((p) => (
            <li key={p.playerId}>
              <span className="pos-badge">{p.position}</span> {p.fullName}
            </li>
          ))}
        </ul>
      )}
      <BestLineupViz roster={viewer.roster} />
    </section>
  );

  const orderPanel =
    state.order.length > 0 ? (
      <section className="panel">
        <h2>Draft order</h2>
        <ol className="order-list">
          {state.order.map((o) => (
            <li
              key={o.slot}
              className={
                inProgress && o.fantasyTeamId === state.onClockTeamId
                  ? "on-clock"
                  : ""
              }
            >
              {o.teamName}{" "}
              <span className="field-hint">({o.managerName})</span>
            </li>
          ))}
        </ol>
      </section>
    ) : null;

  const recentPicks = [...state.picks].reverse();
  const picksPanel = (
    <section className="panel">
      <h2>Picks</h2>
      {recentPicks.length === 0 ? (
        <p className="field-hint">No picks yet.</p>
      ) : (
        <ul className="pick-log">
          {recentPicks.map((p) => (
            <li key={p.pickNumber}>
              <span className="field-hint">#{p.pickNumber}</span>{" "}
              <span className="pos-badge">{p.position}</span> {p.playerName}{" "}
              <span className="field-hint">
                &rarr; {p.teamName}
                {p.isAutopick ? " (auto)" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <>
      <h1>Draft room</h1>
      {errorBar}
      {emailWarning}

      {inProgress ? (
        <div className={viewer.isOnClock ? "draft-banner you" : "draft-banner"}>
          <div>
            <strong>Pick #{state.currentPickNumber}</strong> &middot; Round{" "}
            {state.currentRound} &middot; {state.picksMade}/{state.totalPicks}{" "}
            made
          </div>
          <div>
            {viewer.isOnClock
              ? "You are on the clock"
              : `On the clock: ${onClockSlot?.teamName ?? "-"}`}
            {remaining !== null ? ` - ${formatRemaining(remaining)}` : ""}
          </div>
        </div>
      ) : (
        <div className="draft-banner done">
          <strong>Draft complete</strong> &mdash; all {state.totalPicks} picks
          are in.{" "}
          <a href={`/leagues/${leagueId}/draft/results`}>
            View draft results &rarr;
          </a>{" "}
          &middot;{" "}
          <a href={`/leagues/${leagueId}/standings`}>View standings &rarr;</a>
        </div>
      )}

      <div className="draft-grid">
        <div className="draft-main">
          {inProgress ? (
            board ? (
              <PlayerBoard
                players={board}
                canDraft={viewer.isOnClock}
                busy={actionBusy}
                onDraft={(playerId) =>
                  void runAction("/draft/pick", { playerId })
                }
              />
            ) : (
              <p className="notice">Loading players...</p>
            )
          ) : (
            picksPanel
          )}
        </div>
        <aside className="draft-side">
          {rosterPanel}
          <ScoringRules />
          {orderPanel}
          {inProgress ? picksPanel : null}
          {inProgress ? (
            <section className="panel">
              <h2>Stuck?</h2>
              <p className="field-hint">
                If a pick is past its deadline, process it now instead of
                waiting for the scheduled tick.
              </p>
              <button
                type="button"
                className="btn-link"
                disabled={actionBusy}
                onClick={() => void runAction("/draft/tick")}
              >
                Process timeouts
              </button>
              {viewer.isOwner ? (
                <>
                  <p className="field-hint" style={{ marginTop: "0.75rem" }}>
                    Skip the current pick immediately and autopick for them,
                    even if the timer hasn&apos;t expired.
                  </p>
                  <button
                    type="button"
                    className="btn-link btn-link-warn"
                    disabled={actionBusy}
                    onClick={() => void runAction("/draft/force-pick")}
                  >
                    Force autopick now
                  </button>
                </>
              ) : null}
            </section>
          ) : null}
        </aside>
      </div>
    </>
  );
}
