/**
 * Player stats modal + context (client).
 *
 * Wrap a subtree in <PlayerStatsProvider leagueId={id}> and any descendant
 * client component can call usePlayerStats().openStats(playerId, fullName)
 * to pop a modal showing that player's per-fixture score breakdown, fetched
 * lazily from /api/leagues/[id]/players/[playerId]/breakdown and cached.
 *
 * Used by the roster page: both the pitch graphic (BestLineupViz) and the
 * roster tables open the same modal. Reuses the .xi-overlay / .xi-bd-* CSS
 * already defined for the standings overlay.
 */
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import type { PlayerBreakdown } from "@/data/standings/player-breakdown";

/** Format a points value: trim float noise and prefix a sign. */
function signed(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  const body = Number.isInteger(rounded)
    ? String(rounded)
    : String(rounded).replace(/0+$/, "");
  return rounded > 0 ? `+${body}` : body;
}

/** Format a 0-1 fraction as a whole-percent string. */
function pctOf(n: number): string {
  return `${Math.round(n * 100)}%`;
}

const STAGE_FULL: Record<string, string> = {
  GROUP_1: "Group Stage MD1",
  GROUP_2: "Group Stage MD2",
  GROUP_3: "Group Stage MD3",
  R32: "Round of 32",
  R16: "Round of 16",
  QF: "Quarter-finals",
  SF: "Semi-finals",
  THIRD_PLACE: "Third-place playoff",
  FINAL: "Final",
};

interface OpenStats {
  /** Open the stats modal for a player. No-op when no provider is mounted. */
  openStats: ((playerId: number, fullName: string) => void) | null;
}

const PlayerStatsContext = createContext<OpenStats>({ openStats: null });

/** Read the opener. Returns { openStats: null } outside a provider. */
export function usePlayerStats(): OpenStats {
  return useContext(PlayerStatsContext);
}

/**
 * Inline button that opens a player's stats modal. Renders as plain text when
 * no provider is mounted, so it is always safe to use.
 */
export function PlayerStatButton({
  playerId,
  fullName,
  className,
}: {
  playerId: number;
  fullName: string;
  className?: string;
}) {
  const { openStats } = usePlayerStats();
  if (!openStats) return <>{fullName}</>;
  return (
    <button
      type="button"
      className={className ?? "player-stat-link"}
      onClick={() => openStats(playerId, fullName)}
    >
      {fullName}
    </button>
  );
}

interface Target {
  playerId: number;
  fullName: string;
}

export function PlayerStatsProvider({
  leagueId,
  children,
}: {
  leagueId: number;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const [cache, setCache] = useState<Record<number, PlayerBreakdown>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openStats = useCallback(
    (playerId: number, fullName: string) => {
      setTarget({ playerId, fullName });
      setError(null);
      if (cache[playerId]) return;
      setLoading(true);
      fetch(`/api/leagues/${leagueId}/players/${playerId}/breakdown`)
        .then((r) => r.json())
        .then((json) => {
          if (!json.ok) {
            throw new Error(json.error?.message ?? "could not load breakdown");
          }
          setCache((c) => ({ ...c, [playerId]: json.data as PlayerBreakdown }));
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : "could not load breakdown");
        })
        .finally(() => setLoading(false));
    },
    [leagueId, cache],
  );

  // Escape closes the modal.
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTarget(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target]);

  const data = target ? cache[target.playerId] : undefined;

  return (
    <PlayerStatsContext.Provider value={{ openStats }}>
      {children}
      {target ? (
        <div
          className="xi-overlay"
          onClick={() => setTarget(null)}
          role="presentation"
        >
          <div
            className="xi-overlay-panel"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="xi-overlay-header">
              <span>
                {target.fullName}
                {data ? ` — ${data.position}` : ""}
              </span>
              <button
                type="button"
                className="xi-overlay-close"
                onClick={() => setTarget(null)}
                aria-label="Close"
              >
                &times;
              </button>
            </div>
            {data ? (
              <div className="xi-bd-meta">
                <span>
                  Owned {pctOf(data.ownership.ownershipPct)}
                  <span className="xi-bd-count">
                    {" "}
                    ({data.ownership.ownedCount}/
                    {data.ownership.totalFantasyTeams})
                  </span>
                </span>
                <span>ADP {data.adp !== null ? data.adp : "—"}</span>
              </div>
            ) : null}
            <div className="xi-bd-body">
              {loading ? (
                <p className="xi-bd-status">Loading&hellip;</p>
              ) : error ? (
                <p className="xi-bd-status error">{error}</p>
              ) : !data || data.fixtures.length === 0 ? (
                <p className="xi-bd-status">
                  No scored matches yet for this player.
                </p>
              ) : (
                data.fixtures.map((fx) => (
                  <div key={fx.fixtureId} className="xi-bd-fixture">
                    <div className="xi-bd-head">
                      <span>
                        {STAGE_FULL[fx.stage] ?? fx.stage} &middot; {fx.opponent}
                      </span>
                      <span className="num">{signed(fx.total)}</span>
                    </div>
                    <ul className="xi-bd-rules">
                      {fx.rules.map((r) => (
                        <li key={r.key}>
                          <span className="xi-bd-label">
                            {r.label}
                            {r.count !== null ? (
                              <span className="xi-bd-count"> &times;{r.count}</span>
                            ) : null}
                          </span>
                          <span
                            className={
                              r.points < 0 ? "xi-bd-pts neg" : "xi-bd-pts"
                            }
                          >
                            {signed(r.points)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </PlayerStatsContext.Provider>
  );
}
