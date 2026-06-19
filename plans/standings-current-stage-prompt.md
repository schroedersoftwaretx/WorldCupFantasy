# Standings page — "Current Stage Points" column + "Yet to Play" bar — agent prompt

A focused, self-contained edit to the league standings view. Two changes, both
read-layer + UI only: NO migration, NO scoring-engine changes.

## Orchestrator pre-flight
- [ ] Build from current `main` (Phases 0/1/2/8 merged). `npm run typecheck` and
      `npm test` green first.
- [ ] `git checkout -b standings-current-stage` from up-to-date `main`.

---

## COPY BELOW THIS LINE → paste as the new agent's first message

You are making a focused edit to the **league standings page**. Two changes,
both read-layer + UI only — no migration, no changes to the scoring spine.

Read these first to ground yourself:
1. `app/leagues/[leagueId]/standings/page.tsx` — the page you will edit. Note the
   existing **"Alive" bar** (it renders `getAliveCounts` as
   `alive-bar`/`alive-bar-fill` markup) and the **"Final pts"** column (currently
   `entry.tieBreakers.finalMatchPoints`).
2. `src/web/alive.ts` — `getAliveCounts(db, leagueId)` and the PURE
   `computeAliveState(teams, fixtures)`. This is the EXACT pattern to mirror for
   the new "yet to play" helper (pure core + thin db wrapper + a unit spec).
3. `src/data/standings/standings.ts` — `StandingsEntry` has `periods:
   PeriodResult[]` where each `PeriodResult` is `{ stage: Stage; points: number;
   ... }`, plus `tieBreakers.finalMatchPoints`.
4. `src/data/stats/aggregate.ts` — `STAGE_ORDER` (the full `Stage` enum in
   tournament order) for the current-stage calculation. Fixture statuses
   (`src/data/db/schema.ts`) are `SCHEDULED | LIVE | FINISHED`.

### Change 1 — Replace "Final pts" with current-stage points
- In `standings/page.tsx`, the column headed **"Final pts"** renders
  `entry.tieBreakers.finalMatchPoints`. Replace BOTH the header and the cell:
  - Header → a current-stage label, e.g. `` `${STAGE_LABEL[currentStage]} pts` ``
    (or "Current stage"), so the manager sees which round it is.
  - Cell → that team's points for the current stage only:
    `entry.periods.find((p) => p.stage === currentStage)?.points ?? 0`, rendered
    with `formatPoints`. Keep the existing **"Total"** column immediately to its
    left so total sits next to current-stage points.
- IMPORTANT: this is a DISPLAY change only. Do NOT remove `finalMatchPoints` from
  `tieBreakers` or alter the ranking/tie-break logic in `standings.ts` — the Final
  match is still a real tie-breaker; you are only changing what this column shows.

### Change 2 — Add a "Yet to play" bar alongside the existing "Alive" bar
"Yet to play" = how many of a team's rostered players still have a match to come
in the CURRENT stage (so they can still add to that team's current-stage points).
Keep the Alive bar; add this as a NEW column next to it.

- New helper, mirroring `getAliveCounts` (put it in `src/web/yet-to-play.ts`, or
  extend `alive.ts`). Per fantasy team in the league:
  - `yetToPlay` = count of rostered players whose national team has a fixture in
    the **current stage** whose status is NOT `FINISHED` (i.e. `SCHEDULED` or
    `LIVE` — still a chance to score).
  - `total` = the team's roster size (mirror how the Alive bar uses `total`).
- **Current stage** = the active matchday/round: the earliest stage in
  `STAGE_ORDER` that has at least one non-`FINISHED` fixture. If every fixture is
  `FINISHED`, use the latest stage that has any fixture; before any fixtures
  exist, default to `GROUP_1`. Implement this as a PURE exported function over a
  fixtures slice (like `computeAliveState`) so it is unit-testable, with a thin
  `db`-first wrapper that returns `{ currentStage, byFantasyTeam }`.
- Render a new column beside "Alive" using bar markup that mirrors
  `alive-bar`/`alive-bar-fill`, with a matching new CSS rule in
  `app/globals.css` (e.g. `ytp-bar`/`ytp-bar-fill`). Show `yetToPlay/total` with
  a proportional fill. Pick a sensible tone/colour distinct from the Alive bar.
- Visibility: follow the Alive bar's convention (it hides pre-tournament via its
  `started` flag). Decide and document whether the new bar shows before kickoff;
  a reasonable choice is to show it whenever the current stage still has
  unfinished fixtures.

### Hard rules
- Read-only over existing tables (`fixture`, `roster_slot`, `player`, and
  `score_entry` via `computeStandings`). NO migration. Do NOT touch
  `ruleset.ts` / `score.ts` / `recompute.ts` or any scoring logic.
- Put the new logic in a pure, `db`-first helper with a Vitest spec in `test/`
  (mirror the alive tests): cover current-stage selection (pre-tournament →
  `GROUP_1`; mid-round → that round; all finished → last stage) and the
  per-team yet-to-play count.
- Use `formatPoints` for points; reuse existing markup/classes and keep the page
  server-rendered (no new client component needed). Keep `npm run typecheck` and
  `npm test` green.

### Acceptance criteria
- The "Final pts" column is replaced by a current-stage points column (correct
  stage label, value pulled from `periods` for that stage), with Total beside it.
- A new "Yet to play" bar appears alongside "Alive", showing each team's count of
  rostered players with an unfinished current-stage fixture over the roster total.
- Current-stage selection is spec-verified on seeded fixtures (pre-tournament,
  mid-round, all-finished cases).
- `npm run typecheck` and `npm test` pass.

### Out of scope
- Any scoring-engine change, new migration, or tie-break-logic change.
- The per-period breakdown table below (leave as-is) and the projected-standings
  block (leave as-is).

When done, give a short summary of the files changed and how you verified the
current-stage logic. Do not commit or open a PR unless asked.

## COPY ABOVE THIS LINE
