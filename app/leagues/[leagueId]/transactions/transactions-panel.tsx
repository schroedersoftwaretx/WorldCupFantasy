/**
 * TransactionsPanel - free agents, waiver claims, trade center, and the
 * movement ledger. Serialized hub comes from the server page; every write
 * goes through /api/leagues/[id]/transactions*.
 */
"use client";

import { useMemo, useState } from "react";

interface FreeAgent {
  playerId: number;
  fullName: string;
  position: string;
  nationalTeamId: number;
  onWaiversUntil: string | null;
}

interface RosterPlayer {
  playerId: number;
  fullName: string;
  position: string;
}

interface Claim {
  id: number;
  addPlayerId: number;
  dropPlayerId: number | null;
  status: string;
  processAfter: string;
  note: string | null;
  addPlayerName: string | null;
  dropPlayerName: string | null;
}

interface TradeItemView {
  playerId: number;
  fromTeamId: number;
  toTeamId: number;
}

interface TradeView {
  trade: {
    id: number;
    proposerTeamId: number;
    counterpartyTeamId: number;
    status: string;
    createdAt: string;
  };
  items: TradeItemView[];
  proposerTeamName: string;
  counterpartyTeamName: string;
  playerNames: Record<number, string>;
}

interface LedgerRow {
  id: number;
  kind: string;
  playerName: string | null;
  fromTeamName: string | null;
  toTeamName: string | null;
  effectiveOrdinal: number;
  createdAt: string;
}

interface Hub {
  myTeamId: number;
  waiverHours: number;
  teams: { id: number; name: string; managerId: number }[];
  myRoster: RosterPlayer[];
  rostersByTeam: Record<number, RosterPlayer[]>;
  freeAgents: FreeAgent[];
  myClaims: Claim[];
  trades: TradeView[];
  ledger: LedgerRow[];
}

interface TransactionsPanelProps {
  leagueId: number;
  isOwner: boolean;
  hub: Hub;
  nationNameById: Record<number, string>;
}

export default function TransactionsPanel({
  leagueId,
  isOwner,
  hub,
  nationNameById,
}: TransactionsPanelProps) {
  const now = Date.now();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Free agency state.
  const [search, setSearch] = useState("");
  const [pos, setPos] = useState("ALL");
  const [dropForAdd, setDropForAdd] = useState<number | "">("");

  // Trade state.
  const [tradeTeamId, setTradeTeamId] = useState<number | "">("");
  const [offerIds, setOfferIds] = useState<number[]>([]);
  const [requestIds, setRequestIds] = useState<number[]>([]);
  const otherRoster: RosterPlayer[] =
    tradeTeamId === "" ? [] : (hub.rostersByTeam[tradeTeamId] ?? []);

  const filteredAgents = useMemo(() => {
    const q = search.trim().toLowerCase();
    return hub.freeAgents
      .filter((p) => (pos === "ALL" ? true : p.position === pos))
      .filter((p) => (q === "" ? true : p.fullName.toLowerCase().includes(q)))
      .slice(0, 50);
  }, [hub.freeAgents, search, pos]);

  async function call(
    path: string,
    method: string,
    body?: unknown,
  ): Promise<boolean> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(body);
      }
      const res = await fetch(`/api/leagues/${leagueId}${path}`, init);
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

  async function addPlayer(agent: FreeAgent): Promise<void> {
    const body: Record<string, number> = { addPlayerId: agent.playerId };
    if (dropForAdd !== "") body["dropPlayerId"] = dropForAdd;
    if (await call("/transactions", "POST", body)) window.location.reload();
  }

  async function claimPlayer(agent: FreeAgent): Promise<void> {
    const body: Record<string, number> = { addPlayerId: agent.playerId };
    if (dropForAdd !== "") body["dropPlayerId"] = dropForAdd;
    if (await call("/transactions/waivers", "POST", body)) {
      setMessage("Claim submitted.");
      window.location.reload();
    }
  }

  async function dropOnly(): Promise<void> {
    if (dropForAdd === "") return;
    if (await call("/transactions", "POST", { dropPlayerId: dropForAdd })) {
      window.location.reload();
    }
  }

  async function cancelClaim(claimId: number): Promise<void> {
    if (await call("/transactions/waivers", "PATCH", { claimId })) {
      window.location.reload();
    }
  }

  function toggle(list: number[], id: number): number[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  async function propose(): Promise<void> {
    if (tradeTeamId === "" || offerIds.length === 0 || requestIds.length === 0)
      return;
    if (
      await call("/transactions/trades", "POST", {
        counterpartyTeamId: tradeTeamId,
        offerPlayerIds: offerIds,
        requestPlayerIds: requestIds,
      })
    ) {
      setMessage("Trade proposed.");
      window.location.reload();
    }
  }

  async function actOnTrade(tradeId: number, action: string): Promise<void> {
    if (await call(`/transactions/trades/${tradeId}`, "POST", { action })) {
      window.location.reload();
    }
  }

  const otherTeams = hub.teams.filter((t) => t.id !== hub.myTeamId);
  const openTrades = hub.trades.filter((t) => t.trade.status === "PROPOSED");
  const pastTrades = hub.trades
    .filter((t) => t.trade.status !== "PROPOSED")
    .slice(-5)
    .reverse();
  const pendingClaims = hub.myClaims.filter((c) => c.status === "PENDING");
  const resolvedClaims = hub.myClaims
    .filter((c) => c.status !== "PENDING")
    .slice(-5)
    .reverse();

  return (
    <div className="transactions-panel">
      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="notice">{message}</p> : null}

      <section>
        <h2>Free agents</h2>
        <p className="subtitle">
          Players on waivers (recently dropped) can only be claimed; the claim
          resolves when their window ends. Pair any add with a drop below when
          your roster is full.
        </p>
        <p>
          <input
            type="search"
            placeholder="Search players"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search free agents"
          />{" "}
          <select value={pos} onChange={(e) => setPos(e.target.value)} aria-label="Filter by position">
            {["ALL", "GK", "DEF", "MID", "FWD"].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>{" "}
          <label>
            Drop{" "}
            <select
              value={dropForAdd}
              onChange={(e) =>
                setDropForAdd(e.target.value === "" ? "" : Number(e.target.value))
              }
            >
              <option value="">(nobody)</option>
              {hub.myRoster.map((p) => (
                <option key={p.playerId} value={p.playerId}>
                  {p.fullName} ({p.position})
                </option>
              ))}
            </select>
          </label>{" "}
          <button
            type="button"
            className="btn-sm"
            disabled={busy || dropForAdd === ""}
            onClick={() => void dropOnly()}
          >
            Drop only
          </button>
        </p>
        <table className="stats-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Pos</th>
              <th>Nation</th>
              <th>Status</th>
              <th aria-label="action" />
            </tr>
          </thead>
          <tbody>
            {filteredAgents.map((p) => {
              const onWaivers =
                p.onWaiversUntil !== null && Date.parse(p.onWaiversUntil) > now;
              return (
                <tr key={p.playerId}>
                  <td>{p.fullName}</td>
                  <td>{p.position}</td>
                  <td>{nationNameById[p.nationalTeamId] ?? "-"}</td>
                  <td>
                    {onWaivers
                      ? `Waivers until ${new Date(p.onWaiversUntil as string).toLocaleString()}`
                      : "Free agent"}
                  </td>
                  <td>
                    {onWaivers ? (
                      <button
                        type="button"
                        className="btn-sm"
                        disabled={busy}
                        onClick={() => void claimPlayer(p)}
                      >
                        Claim
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-sm"
                        disabled={busy}
                        onClick={() => void addPlayer(p)}
                      >
                        Add
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {filteredAgents.length === 0 ? (
              <tr>
                <td colSpan={5} className="notice">
                  No free agents match.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section>
        <h2>My waiver claims</h2>
        {pendingClaims.length === 0 && resolvedClaims.length === 0 ? (
          <p className="notice">No claims yet.</p>
        ) : (
          <ul>
            {pendingClaims.map((c) => (
              <li key={c.id}>
                Claim {c.addPlayerName ?? `#${c.addPlayerId}`}
                {c.dropPlayerId !== null
                  ? ` (dropping ${c.dropPlayerName ?? `#${c.dropPlayerId}`})`
                  : ""}{" "}
                - processes {new Date(c.processAfter).toLocaleString()}{" "}
                <button
                  type="button"
                  className="btn-sm"
                  disabled={busy}
                  onClick={() => void cancelClaim(c.id)}
                >
                  Cancel
                </button>
              </li>
            ))}
            {resolvedClaims.map((c) => (
              <li key={c.id}>
                {c.addPlayerName ?? `#${c.addPlayerId}`}: {c.status}
                {c.note ? ` (${c.note})` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Trade center</h2>
        {openTrades.length > 0 ? (
          <ul>
            {openTrades.map((t) => {
              const iAmCounterparty = t.trade.counterpartyTeamId === hub.myTeamId;
              const iAmProposer = t.trade.proposerTeamId === hub.myTeamId;
              const gives = t.items.filter(
                (i) => i.fromTeamId === t.trade.proposerTeamId,
              );
              const gets = t.items.filter(
                (i) => i.fromTeamId === t.trade.counterpartyTeamId,
              );
              return (
                <li key={t.trade.id}>
                  <strong>{t.proposerTeamName}</strong> sends{" "}
                  {gives.map((i) => t.playerNames[i.playerId]).join(", ")} to{" "}
                  <strong>{t.counterpartyTeamName}</strong> for{" "}
                  {gets.map((i) => t.playerNames[i.playerId]).join(", ")}{" "}
                  {iAmCounterparty ? (
                    <>
                      <button
                        type="button"
                        className="btn-sm"
                        disabled={busy}
                        onClick={() => void actOnTrade(t.trade.id, "ACCEPT")}
                      >
                        Accept
                      </button>{" "}
                      <button
                        type="button"
                        className="btn-sm"
                        disabled={busy}
                        onClick={() => void actOnTrade(t.trade.id, "REJECT")}
                      >
                        Reject
                      </button>
                    </>
                  ) : null}{" "}
                  {iAmProposer ? (
                    <button
                      type="button"
                      className="btn-sm"
                      disabled={busy}
                      onClick={() => void actOnTrade(t.trade.id, "CANCEL")}
                    >
                      Cancel
                    </button>
                  ) : null}{" "}
                  {isOwner && !iAmProposer && !iAmCounterparty ? (
                    <button
                      type="button"
                      className="btn-sm"
                      disabled={busy}
                      onClick={() => void actOnTrade(t.trade.id, "VETO")}
                    >
                      Veto
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="notice">No open trade offers.</p>
        )}

        <h3>Propose a trade</h3>
        <p>
          <label>
            With{" "}
            <select
              value={tradeTeamId}
              onChange={(e) => {
                const v = e.target.value === "" ? "" : Number(e.target.value);
                setTradeTeamId(v);
                setRequestIds([]);
              }}
            >
              <option value="">(choose a team)</option>
              {otherTeams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </p>
        {tradeTeamId !== "" ? (
          <div className="trade-builder">
            <div>
              <h4>You send</h4>
              <ul className="checkbox-list">
                {hub.myRoster.map((p) => (
                  <li key={p.playerId}>
                    <label>
                      <input
                        type="checkbox"
                        checked={offerIds.includes(p.playerId)}
                        onChange={() => setOfferIds(toggle(offerIds, p.playerId))}
                      />{" "}
                      {p.fullName} ({p.position})
                    </label>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4>You receive</h4>
              {otherRoster.length === 0 ? (
                <p className="notice">That team has no rostered players.</p>
              ) : (
                <ul className="checkbox-list">
                  {otherRoster.map((p) => (
                    <li key={p.playerId}>
                      <label>
                        <input
                          type="checkbox"
                          checked={requestIds.includes(p.playerId)}
                          onChange={() =>
                            setRequestIds(toggle(requestIds, p.playerId))
                          }
                        />{" "}
                        {p.fullName} ({p.position})
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p>
              <button
                type="button"
                className="btn-sm"
                disabled={
                  busy || offerIds.length === 0 || requestIds.length === 0
                }
                onClick={() => void propose()}
              >
                Propose trade
              </button>
            </p>
          </div>
        ) : null}

        {pastTrades.length > 0 ? (
          <>
            <h3>Recent trades</h3>
            <ul>
              {pastTrades.map((t) => (
                <li key={t.trade.id}>
                  {t.proposerTeamName} &harr; {t.counterpartyTeamName}:{" "}
                  {t.trade.status}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section>
        <h2>Recent moves</h2>
        {hub.ledger.length === 0 ? (
          <p className="notice">No transactions yet.</p>
        ) : (
          <ul>
            {[...hub.ledger].reverse().map((r) => (
              <li key={r.id}>
                {r.kind === "ADD"
                  ? `${r.toTeamName ?? "?"} added ${r.playerName ?? "?"}`
                  : r.kind === "DROP"
                    ? `${r.fromTeamName ?? "?"} dropped ${r.playerName ?? "?"}`
                    : `${r.playerName ?? "?"} traded from ${r.fromTeamName ?? "?"} to ${r.toTeamName ?? "?"}`}{" "}
                ({new Date(r.createdAt).toLocaleString()})
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
