# Phase 2 — Player Insights (Ownership, ADP, Differentials)

**Prerequisites:** Phase 1 (stats aggregate layer).
**Read first:** `PLAN.md` §2 (draft format), `src/data/db/schema.ts`
(`roster_slot`, `draft_pick`), `src/data/draft/`.

## Goal

Turn picks into strategy. Because this is a **draft** league, a player is owned
at most once per league — so "ownership %" and "differential" only become
meaningful **across leagues** and via **draft analytics (ADP)**. This phase adds
that cross-league context plus per-player value framing.

## Why

FPL's ownership % and "differential" framing is one of its stickiest features.
Adapting it to a draft format (global ownership %, average draft position,
reach/steal analysis) gives managers a strategic lens both during the draft and
across the tournament, without changing the core format.

## Design / approach

### 2.1 Global ownership %
- Service `src/data/stats/ownership.ts`: for each player, `ownedCount =`
  distinct fantasy teams across all leagues holding them (`roster_slot`), and
  `ownershipPct = ownedCount / totalFantasyTeams`. Optionally scope to "leagues
  that have finished drafting" for cleaner denominators.
- Surface on player profiles/modals (`player-stats-modal.tsx`) and in the Stats
  Hub leaderboards as a column.

### 2.2 ADP & draft analytics
- Service `src/data/stats/adp.ts` over `draft_pick`: average `pick_number` per
  player (ADP), earliest/latest pick, % of drafts where taken, and
  pick-vs-`draft_rank` (reach/steal: ADP minus pre-tournament `draft_rank`).
- A public "Draft Trends" page: sortable table of ADP, ownership %, and
  reach/steal; filter by position and nation.
- In an **active** draft room, optionally show live ADP next to each available
  player to inform picks (read-only overlay; do not change autopick logic).

### 2.3 Differentials & value
- "Differential" = a player you roster who is rare globally (low ownership %)
  but scoring well (high `score_entry` total) — surface per fantasy team on the
  team page: "Your differentials" (low-owned, high-scoring) and "Template"
  (high-owned) players.
- "Value" = points per the slot they were drafted at (points / ADP or points /
  draft round) — a single derived number to rank steals of the tournament.

### 2.4 Privacy / fairness
- Ownership and ADP aggregate across leagues, so expose only **aggregate**
  numbers, never which specific rival team owns whom outside one's own league.

## Tasks
- [ ] `src/data/stats/ownership.ts` (+ spec): global ownership counts/percent.
- [ ] `src/data/stats/adp.ts` (+ spec): ADP, take-rate, reach/steal vs
      `draft_rank`.
- [ ] `GET /api/stats/ownership`, `GET /api/stats/adp`.
- [ ] Public "Draft Trends" page (sortable, filterable).
- [ ] Add ownership %/ADP columns to player modal + Stats Hub leaderboards.
- [ ] Per-team "Your differentials / template / best value" panel on the team
      page (`app/leagues/[leagueId]/roster/[teamId]`).
- [ ] Optional live-ADP overlay in the draft room (read-only).

## Acceptance criteria
- [ ] Ownership % equals distinct-team count / total teams for a seeded
      multi-league fixture (spec-verified).
- [ ] ADP equals the mean pick number across seeded drafts; reach/steal sign is
      correct (negative = drafted earlier than rank).
- [ ] Differentials panel lists only the viewing manager's own players and never
      leaks rival rosters from other leagues.
- [ ] `npm run typecheck` and `npm test` pass.

## Out of scope
- Trades/waivers (not part of best-ball).
- Projections (already exist in `src/data/projection`); reuse, don't rebuild.
