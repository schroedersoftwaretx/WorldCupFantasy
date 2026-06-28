/**
 * The draft room (client component).
 *
 * Subscribes to the draft state over Server-Sent Events (falling back to
 * polling if the stream drops), and renders the right view for the draft's
 * status: a create form, a start screen, the live room (player board + roster
 * + order + picks), or a completed summary. All mutations go through the POST
 * routes; the live stream reflects the result.
 *
 * This component is the stateful container: it owns all state, effects, timers,
 * and fetching, and feeds plain data + callbacks to the presentational panels
 * under ./components.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { DraftBoardPlayer, DraftStateData } from "@/web/api-types";
import type { QueueEntry } from "@/data/draft/queue";
import type { ScoringRuleset } from "@/data/scoring/ruleset";

import PlayerBoard from "./player-board";
import QueuePanel from "./queue-panel";
import { ScoringRules } from "./scoring-rules";
import { POLL_MS, type Envelope } from "./types";

import BestAvailableHints from "./components/BestAvailableHints";
import CreateDraftPanel from "./components/CreateDraftPanel";
import DraftOrderPanel from "./components/DraftOrderPanel";
import OnClockBanner from "./components/OnClockBanner";
import PicksPanel from "./components/PicksPanel";
import RecentPicksTicker from "./components/RecentPicksTicker";
import RosterPanel from "./components/RosterPanel";
import StartDraftPanel from "./components/StartDraftPanel";
import StatusBanners from "./components/StatusBanners";
import StuckPanel from "./components/StuckPanel";

async function readBody(res: Response): Promise<Envelope | null> {
  return res.json().catch(() => null);
}

export default function DraftRoom({
  leagueId,
  ruleset,
}: {
  leagueId: number;
  ruleset: ScoringRuleset;
}) {
  const [state, setState] = useState<DraftStateData | null>(null);
  const [board, setBoard] = useState<DraftBoardPlayer[] | null>(null);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [queueBusy, setQueueBusy] = useState(false);
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

  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch(`/api/leagues/${leagueId}/draft/queue`, {
        cache: "no-store",
      });
      const body = await readBody(res);
      if (!res.ok || !body?.data) return;
      setQueue((body.data as { queue: QueueEntry[] }).queue);
    } catch {
      // Non-fatal: the queue panel just keeps its last state.
    }
  }, [leagueId]);

  const mutateQueue = useCallback(
    async (payload: unknown) => {
      setQueueBusy(true);
      try {
        const res = await fetch(`/api/leagues/${leagueId}/draft/queue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await readBody(res);
        if (!res.ok || !body?.data) {
          throw new Error(body?.error?.message ?? "could not update the queue");
        }
        setQueue((body.data as { queue: QueueEntry[] }).queue);
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "could not update the queue");
      } finally {
        setQueueBusy(false);
      }
    },
    [leagueId],
  );

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
      void fetchQueue();
    }
  }, [state, fetchBoard, fetchQueue]);

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
  const queuedIds = new Set(queue.map((e) => e.playerId));
  const toggleQueue = (playerId: number, queued: boolean): void => {
    void mutateQueue(
      queued ? { action: "add", playerId } : { action: "remove", playerId },
    );
  };

  // Owner-only heads-up when email delivery isn't configured, so they know
  // managers won't get "you're on the clock" emails.
  const showEmailWarning = viewer.isOwner && !state.emailNotifications;

  // --- no draft room yet ----------------------------------------------------
  if (state.status === "NONE") {
    return (
      <>
        <h1>Draft room</h1>
        <StatusBanners actionError={actionError} showEmailWarning={false} />
        <CreateDraftPanel
          isOwner={viewer.isOwner}
          actionBusy={actionBusy}
          timerInput={timerInput}
          onTimerInputChange={setTimerInput}
          onCreate={() =>
            void runAction("/draft", { pickTimerHours: Number(timerInput) })
          }
        />
      </>
    );
  }

  // --- created, not started -------------------------------------------------
  if (state.status === "PENDING") {
    return (
      <>
        <h1>Draft room</h1>
        <StatusBanners
          actionError={actionError}
          showEmailWarning={showEmailWarning}
        />
        <StartDraftPanel
          isOwner={viewer.isOwner}
          actionBusy={actionBusy}
          teamCount={state.teamCount}
          pickTimerHours={state.pickTimerHours}
          onStart={() => void runAction("/draft/start")}
        />
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

  return (
    <>
      <h1>Draft room</h1>
      <StatusBanners
        actionError={actionError}
        showEmailWarning={showEmailWarning}
      />

      <OnClockBanner
        inProgress={inProgress}
        isOnClock={viewer.isOnClock}
        currentPickNumber={state.currentPickNumber}
        currentRound={state.currentRound}
        picksMade={state.picksMade}
        totalPicks={state.totalPicks}
        onClockTeamName={onClockSlot?.teamName}
        remaining={remaining}
        leagueId={leagueId}
      />

      {inProgress ? (
        <>
          <RecentPicksTicker picks={state.picks} />
          <BestAvailableHints board={board} />
        </>
      ) : null}

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
                queuedIds={queuedIds}
                onToggleQueue={toggleQueue}
              />
            ) : (
              <p className="notice">Loading players...</p>
            )
          ) : (
            <PicksPanel picks={state.picks} />
          )}
        </div>
        <aside className="draft-side">
          <RosterPanel
            counts={viewer.counts}
            roster={viewer.roster}
            rosterSize={state.rosterSize}
          />
          {inProgress ? (
            <QueuePanel
              queue={queue}
              busy={queueBusy}
              onReorder={(order) => void mutateQueue({ action: "reorder", order })}
              onRemove={(playerId) =>
                void mutateQueue({ action: "remove", playerId })
              }
            />
          ) : null}
          <ScoringRules ruleset={ruleset} />
          <DraftOrderPanel
            order={state.order}
            inProgress={inProgress}
            onClockTeamId={state.onClockTeamId}
          />
          {inProgress ? <PicksPanel picks={state.picks} /> : null}
          {inProgress ? (
            <StuckPanel
              isOwner={viewer.isOwner}
              actionBusy={actionBusy}
              onProcessTimeouts={() => void runAction("/draft/tick")}
              onForcePick={() => void runAction("/draft/force-pick")}
            />
          ) : null}
        </aside>
      </div>
    </>
  );
}
